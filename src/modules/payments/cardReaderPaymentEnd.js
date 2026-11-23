import TableSession from "../ordering/session.model.js";
import Payment, { PAYMENT_METHOD } from "./payment.model.js";
import { cancelCardReaderPaymentIntent, stopCollectingOnCardReader } from "../payouts/stripe.js";
import { publishBillUnfrozen } from "./events.js";
import { reconcileCardReaderPayment } from "./cardReaderCapture.service.js";
import {
  CARD_READER_ATTEMPT,
  isCardReaderAttempt,
  reopenFrozenBill,
  sessionStatusOf,
  UNFREEZE_REASON,
} from "./billFreeze.js";
import { stripeAccountOf } from "./stripeContext.js";
import { AppError } from "../../shared/errors.js";
import { captureException, logger } from "../../shared/logger.js";

// How a card reader payment ends without the card going through (ADR-0008,
// docs/payments-contract.md "Paying on a card reader"): cancelled by staff,
// expired, or staff taking the money another way. The bill unfreezes first,
// so the authorization webhook can no longer capture it, whatever Stripe
// does next. Then the reader is cleared and the PaymentIntent cancelled,
// releasing any authorization; when Stripe cannot be reached that is only
// logged, and a card that still goes through is cancelled by the webhook.

// Clears the reader and cancels the PaymentIntent, best effort.
const stopOnStripe = async (ctx, sessionId, attempt) => {
  if (!attempt.paymentIntentId) return;
  const log = {
    restaurantId: String(ctx.restaurantId),
    sessionId: String(sessionId),
    paymentIntentId: attempt.paymentIntentId,
    requestId: ctx.requestId,
  };
  let stripeAccountId;
  try {
    stripeAccountId = await stripeAccountOf(ctx.restaurantId);
    await stopCollectingOnCardReader({
      stripeAccountId,
      stripeReaderId: attempt.stripeReaderId,
      paymentIntentId: attempt.paymentIntentId,
    });
  } catch (error) {
    logger.error({ ...log, err: error }, "clearing the card reader failed");
    captureException(error);
  }
  try {
    await cancelCardReaderPaymentIntent({ stripeAccountId, paymentIntentId: attempt.paymentIntentId });
  } catch (error) {
    logger.error({ ...log, err: error }, "cancelling the card reader PaymentIntent failed");
    captureException(error);
  }
};

// The card may have gone through while its webhook never arrived: then it
// is recorded as the bill's Payment instead of being released. When Stripe
// cannot be read that is only logged, and the payment ends anyway.
const cardWentThrough = async (ctx, sessionId) => {
  try {
    return await reconcileCardReaderPayment(ctx.restaurantId, sessionId);
  } catch (error) {
    logger.error(
      { restaurantId: String(ctx.restaurantId), sessionId: String(sessionId), requestId: ctx.requestId, err: error },
      "checking the card reader payment with Stripe failed"
    );
    captureException(error);
    return false;
  }
};

// Ends the card reader payment the bill is frozen for, publishing
// `bill.unfrozen` with `reason`. With `expiredBy`, only an attempt that
// expired by then. Nothing else frozen, or nothing frozen, is left as it is.
// Returns { status, ended } with the session's status afterwards.
export const endCardReaderPayment = async (ctx, sessionId, { reason, expiredBy } = {}) => {
  const session = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId })
    .select("status paymentInProgress")
    .lean();
  if (!session) throw new AppError("NOT_FOUND", "Not found", 404);
  if (!isCardReaderAttempt(session)) return { status: session.status, ended: false };
  const attempt = session.paymentInProgress;
  const notEnded = async () => ({ status: await sessionStatusOf(ctx.restaurantId, sessionId), ended: false });
  if (await cardWentThrough(ctx, sessionId)) return notEnded();

  const reopened = await reopenFrozenBill({
    restaurantId: ctx.restaurantId,
    sessionId,
    attemptId: attempt.attemptId,
    match: expiredBy ? { "paymentInProgress.expiresAt": { $lte: expiredBy } } : {},
  });
  // The card went through, or something else ended it first.
  if (!reopened) return notEnded();
  await stopOnStripe(ctx, sessionId, attempt);
  publishBillUnfrozen({ restaurantId: ctx.restaurantId, sessionId, reason });
  return { status: "open", ended: true };
};

// Staff cancel the bill's card reader payment. Nothing in progress answers
// the session's status; a bill the card already paid answers BILL_PAID.
// A FAILED attempt kept for Retry (failedCardReaderPayment) is
// dropped too, so the pay panel shows none.
export const cancelCardReaderPayment = async (ctx, sessionId) => {
  const { status, ended } = await endCardReaderPayment(ctx, sessionId, { reason: UNFREEZE_REASON.CANCELLED });
  await TableSession.updateOne(
    { _id: sessionId, restaurantId: ctx.restaurantId },
    { $unset: { failedCardReaderPayment: 1 } }
  );
  if (!ended && (await Payment.exists({ restaurantId: ctx.restaurantId, sessionId, method: PAYMENT_METHOD.CARD_READER }))) {
    throw new AppError("BILL_PAID", "This bill is paid");
  }
  return { status };
};

// Ends every card reader payment, across restaurants, that nobody finished
// by its expiresAt, with reason EXPIRED. Returns how many it ended.
export const expireCardReaderPayments = async ({ now = new Date(), limit = 50 } = {}) => {
  const due = await TableSession.find({ ...CARD_READER_ATTEMPT, "paymentInProgress.expiresAt": { $lte: now } })
    .select("restaurantId")
    .limit(limit)
    .setOptions({ skipTenant: true })
    .lean();
  let ended = 0;
  for (const session of due) {
    const ctx = { restaurantId: session.restaurantId, requestId: "card-reader-expiry" };
    try {
      const { ended: expired } = await endCardReaderPayment(ctx, session._id, {
        reason: UNFREEZE_REASON.EXPIRED,
        expiredBy: now,
      });
      if (expired) ended += 1;
    } catch (error) {
      logger.error({ sessionId: String(session._id), err: error }, "expiring a card reader payment failed");
      captureException(error);
    }
  }
  return ended;
};
