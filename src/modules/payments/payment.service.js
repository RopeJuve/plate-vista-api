import mongoose from "mongoose";
import Payment from "./payment.model.js";
import Restaurant from "../restaurants/restaurant.model.js";
import { serializePayment } from "./serialize.js";
import { recordPaymentSchema } from "./payment.schemas.js";
import { requestSigning } from "./signing.js";
import { isTseActive } from "../tse/tse.service.js";
import { getSessionBill } from "../ordering/order.service.js";
import { findSession, touchSession } from "../ordering/session.service.js";
import { AppError, isDuplicateKey } from "../../shared/errors.js";
import { parseOrThrow } from "../../shared/validate.js";
import { captureException, logger } from "../../shared/logger.js";

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

// Records that staff took the bill's money in cash or at the card terminal.
// Returns { payment, replayed }; a replay is the payment an earlier request
// with the same clientPaymentId recorded.
export const recordPayment = async (ctx, sessionId, input) => {
  await findSession(ctx.restaurantId, sessionId);
  const payload = parseOrThrow(recordPaymentSchema, input);
  const { clientPaymentId } = payload;
  const earlier = await findReplay(ctx.restaurantId, sessionId, clientPaymentId);
  if (earlier) return { payment: serializePayment(earlier), replayed: true };

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
      if (bill.totalCents === 0) {
        throw new AppError("BILL_EMPTY", "The bill is empty; close the table instead");
      }
      if (bill.totalCents !== payload.expectedTotalCents) {
        throw new AppError("BILL_CHANGED", "The bill changed; check the new total", undefined, {
          totalCents: bill.totalCents,
        });
      }
      await touchSession(ctx.restaurantId, sessionId, mongoSession);
      const [payment] = await Payment.create(
        [
          {
            restaurantId: ctx.restaurantId,
            sessionId,
            tableId: bill.session.tableId,
            method: payload.method,
            amountCents: bill.totalCents,
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
    if (replay) return { payment: serializePayment(replay), replayed: true };
    throw new AppError("BILL_PAID", "This bill is paid");
  } finally {
    await mongoSession.endSession();
  }

  if (!result.replayed) {
    try {
      await requestSigning({ kind: "PAYMENT", id: result.payment._id });
    } catch (error) {
      // The payment stands; the signing sweep picks it up (ADR-0005).
      logger.error({ restaurantId: ctx.restaurantId, paymentId: String(result.payment._id), err: error }, "signing request failed");
      captureException(error);
    }
  }
  return { payment: serializePayment(result.payment), replayed: result.replayed };
};
