import mongoose from "mongoose";
import Payment, { PAYMENT_METHOD } from "./payment.model.js";
import TableSession, { PAYMENT_IN_PROGRESS_KIND } from "../ordering/session.model.js";
import Restaurant from "../restaurants/restaurant.model.js";
import { serializePayment } from "./serialize.js";
import { recordPaymentSchema } from "./payment.schemas.js";
import { requestSigning } from "./signing.js";
import { publishBillPaid } from "./events.js";
import { endPaymentInProgress } from "./unfreeze.js";
import { isCardReaderAttempt, reopenFrozenBill } from "./billFreeze.js";
import { isTseActive } from "../tse/tse.service.js";
import { getSessionBill } from "../ordering/order.service.js";
import { findSession, touchSession } from "../ordering/session.service.js";
import { AppError, isDuplicateKey } from "../../shared/errors.js";
import { parseOrThrow } from "../../shared/validate.js";
import { captureException, logger } from "../../shared/logger.js";
import { captureCardReaderPayment } from "../payouts/stripe.js";

const findReplay = async (restaurantId, sessionId, clientPaymentId, mongoSession) => {
  const query = Payment.findOne({ restaurantId, clientPaymentId });
  if (mongoSession) query.session(mongoSession);
  const payment = await query;
  if (payment && String(payment.sessionId) !== String(sessionId)) {
    throw new AppError("VALIDATION", "clientPaymentId was used for another bill", 400, {
      fields: { clientPaymentId: "already used for another bill" },
    });
  }
  return payment;
};

const assertTseActive = async (restaurantId, mongoSession) => {
  const restaurant = await Restaurant.findById(restaurantId)
    .select("tse.setupStep")
    .session(mongoSession)
    .lean();
  if (!isTseActive(restaurant)) {
    throw new AppError("TSE_NOT_ACTIVE", "Activate the TSE before taking payments");
  }
};

// The one path every Payment takes, whoever records it: in a transaction it
// checks the bill, lets `settle` check what this kind of payment needs and
// name the amount, and writes the Payment; then it publishes `bill.paid` and
// asks the TSE to sign it (ADR-0003, ADR-0005). Returns { payment, replayed };
// a replay is the payment an earlier call with the same clientPaymentId
// recorded.
const payBill = async (ctx, sessionId, { method, clientPaymentId, settle }) => {
  const earlier = await findReplay(ctx.restaurantId, sessionId, clientPaymentId);
  if (earlier) return { payment: earlier, replayed: true };

  let result;
  const mongoSession = await mongoose.startSession();
  try {
    result = await mongoSession.withTransaction(async () => {
      const replay = await findReplay(ctx.restaurantId, sessionId, clientPaymentId, mongoSession);
      if (replay) return { payment: replay, replayed: true };
      await assertTseActive(ctx.restaurantId, mongoSession);
      // Read in the transaction: a new order or cancel that commits first
      // makes this one conflict on the session document and re-read the bill.
      const bill = await getSessionBill(ctx, sessionId, mongoSession);
      if (bill.payment) throw new AppError("BILL_PAID", "This bill is paid");
      // settle writes the session document, so changes to the bill conflict.
      const amountCents = await settle(bill, mongoSession);
      const [payment] = await Payment.create(
        [
          {
            restaurantId: ctx.restaurantId,
            sessionId,
            tableId: bill.session.tableId,
            method,
            amountCents,
            paidAt: new Date(),
            paidBy: ctx.actor?.type === "employee" ? ctx.actor.id : undefined,
            clientPaymentId,
            tse: { status: "PENDING" },
          },
        ],
        { session: mongoSession }
      );
      return { payment, replayed: false };
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // Another request paid this bill first: the same payment, or a different one.
    const replay = await findReplay(ctx.restaurantId, sessionId, clientPaymentId);
    if (replay) return { payment: replay, replayed: true };
    throw new AppError("BILL_PAID", "This bill is paid");
  } finally {
    await mongoSession.endSession();
  }

  if (!result.replayed) {
    publishBillPaid(result.payment);
    try {
      await requestSigning({ kind: "PAYMENT", id: result.payment._id });
    } catch (error) {
      // The payment stands; the signing sweep picks it up (ADR-0005).
      logger.error({ restaurantId: ctx.restaurantId, paymentId: String(result.payment._id), err: error }, "signing request failed");
      captureException(error);
    }
  }
  return result;
};

// Records that staff took the bill's money in cash or at the card terminal.
// Staff win over an online or card reader payment: a frozen bill is unfrozen
// first, even when Stripe cannot be reached. Returns { payment, replayed }; a
// replay is the payment an earlier request with the same clientPaymentId
// recorded.
export const recordPayment = async (ctx, sessionId, input) => {
  await findSession(ctx.restaurantId, sessionId);
  const payload = parseOrThrow(recordPaymentSchema, input);
  await endPaymentInProgress(ctx, sessionId);
  const { payment, replayed } = await payBill(ctx, sessionId, {
    method: payload.method,
    clientPaymentId: payload.clientPaymentId,
    settle: async (bill, mongoSession) => {
      if (bill.totalCents === 0) {
        throw new AppError("BILL_EMPTY", "The bill is empty; close the table instead");
      }
      if (bill.totalCents !== payload.expectedTotalCents) {
        throw new AppError("BILL_CHANGED", "The bill changed; check the new total", undefined, {
          totalCents: bill.totalCents,
        });
      }
      await touchSession(ctx.restaurantId, sessionId, mongoSession);
      return bill.totalCents;
    },
  });
  return { payment: serializePayment(payment), replayed };
};

// Why an online payment that completed cannot become the bill's Payment
// (a Late Payment, GLOSSARY.md); the reasons are OnlinePaymentRefund's.
const latePayment = (reason) =>
  new AppError("LATE_PAYMENT", "The online payment came too late for this bill", 409, { reason });

// Records the guest's online payment once Stripe says the Checkout Session
// is paid. Only the Checkout Session the bill is frozen for pays it: the
// Payment's amount is the frozen bill's, the Checkout Session id is its
// clientPaymentId, so a repeated event replays, and the session is open
// again. Anything else throws LATE_PAYMENT with the reason.
export const recordOnlinePayment = async (ctx, sessionId, checkoutSessionId) => {
  try {
    return await payBill(ctx, sessionId, {
      method: PAYMENT_METHOD.ONLINE,
      clientPaymentId: checkoutSessionId,
      settle: async (bill, mongoSession) => {
        const session = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId })
          .select("status paymentInProgress")
          .session(mongoSession)
          .lean();
        if (session.status === "closed") throw latePayment("SESSION_CLOSED");
        const attempt = session.paymentInProgress;
        if (
          session.status !== "paying" ||
          attempt?.kind !== PAYMENT_IN_PROGRESS_KIND.ONLINE ||
          attempt.checkoutSessionId !== checkoutSessionId
        ) {
          throw latePayment("BILL_NOT_FROZEN");
        }
        await reopenFrozenBill({ restaurantId: ctx.restaurantId, sessionId, attemptId: attempt.attemptId, mongoSession });
        return attempt.amountCents;
      },
    });
  } catch (error) {
    if (error?.code === "BILL_PAID") throw latePayment("BILL_ALREADY_PAID");
    throw error;
  }
};

// Records a card reader payment once Stripe says the card was authorized
// (ADR-0008). Only the PaymentIntent the bill is frozen for pays it: it is
// captured right there, while the bill is still frozen, and the Payment's
// amount is the frozen bill's. The PaymentIntent id is its clientPaymentId,
// so a repeated event replays without capturing again; the capture's
// idempotency key covers a transaction that runs twice. Anything else throws
// NOT_FROZEN_FOR_IT and nothing is captured.
export const recordCardReaderPayment = (ctx, sessionId, { paymentIntentId, stripeAccountId }) =>
  payBill(ctx, sessionId, {
    method: PAYMENT_METHOD.CARD_READER,
    clientPaymentId: paymentIntentId,
    settle: async (bill, mongoSession) => {
      const session = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId })
        .select("status paymentInProgress")
        .session(mongoSession)
        .lean();
      const attempt = session.paymentInProgress;
      if (!isCardReaderAttempt(session) || attempt.paymentIntentId !== paymentIntentId) {
        throw new AppError("NOT_FROZEN_FOR_IT", "The bill is not frozen for this card reader payment");
      }
      await reopenFrozenBill({ restaurantId: ctx.restaurantId, sessionId, attemptId: attempt.attemptId, mongoSession });
      await captureCardReaderPayment({ stripeAccountId, paymentIntentId });
      return attempt.amountCents;
    },
  });
