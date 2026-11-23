import Restaurant from "../restaurants/restaurant.model.js";
import TableSession from "../ordering/session.model.js";
import Payment from "./payment.model.js";
import { cancelCardReaderPaymentIntent, stopCollectingOnCardReader } from "../payouts/stripe.js";
import { publishBillUnfrozen } from "./events.js";
import { AppError } from "../../shared/errors.js";
import { captureException, logger } from "../../shared/logger.js";

// How a card reader payment ends without the card going through (ADR-0008,
// docs/payments-contract.md "Paying on a card reader"): cancelled by staff,
// expired, or staff taking the money another way. The bill unfreezes first,
// so the authorization webhook can no longer capture it, whatever Stripe
// does next. Then the reader is cleared and the PaymentIntent cancelled,
// releasing any authorization; when Stripe cannot be reached that is only
// logged, and a card that still goes through is cancelled by the webhook.

const stripeAccountOf = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("payoutAccount.stripeAccountId").lean();
  return restaurant?.payoutAccount?.stripeAccountId;
};

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

// Ends the card reader payment the bill is frozen for, publishing
// `bill.unfrozen` with `reason`. With `expiredBy`, only an attempt that
// expired by then. Nothing else frozen, or nothing frozen, is left as it is.
// Returns { status, ended } with the session's status afterwards.
export const endCardReaderPayment = async (ctx, sessionId, { reason, expiredBy } = {}) => {
  const session = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId })
    .select("status paymentInProgress")
    .lean();
  if (!session) throw new AppError("NOT_FOUND", "Not found", 404);
  const attempt = session.paymentInProgress;
  if (session.status !== "paying" || attempt?.kind !== "card_reader") return { status: session.status, ended: false };

  const filter = {
    _id: sessionId,
    restaurantId: ctx.restaurantId,
    status: "paying",
    "paymentInProgress.attemptId": attempt.attemptId,
  };
  if (expiredBy) filter["paymentInProgress.expiresAt"] = { $lte: expiredBy };
  const result = await TableSession.updateOne(filter, { $set: { status: "open" }, $unset: { paymentInProgress: 1 } });
  if (result.modifiedCount === 0) {
    // The card went through, or something else ended it first.
    const now = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId }).select("status").lean();
    return { status: now.status, ended: false };
  }
  await stopOnStripe(ctx, sessionId, attempt);
  publishBillUnfrozen({ restaurantId: ctx.restaurantId, sessionId, reason });
  return { status: "open", ended: true };
};

// Staff cancel the bill's card reader payment. Nothing in progress answers
// the session's status; a bill the card already paid answers BILL_PAID.
// A FAILED attempt kept for Retry (failedCardReaderPayment) is
// dropped too, so the pay panel shows none.
export const cancelCardReaderPayment = async (ctx, sessionId) => {
  const { status, ended } = await endCardReaderPayment(ctx, sessionId, { reason: "CANCELLED" });
  await TableSession.updateOne(
    { _id: sessionId, restaurantId: ctx.restaurantId },
    { $unset: { failedCardReaderPayment: 1 } }
  );
  if (!ended && (await Payment.exists({ restaurantId: ctx.restaurantId, sessionId, method: "CARD_READER" }))) {
    throw new AppError("BILL_PAID", "This bill is paid");
  }
  return { status };
};

// Ends every card reader payment, across restaurants, that nobody finished
// by its expiresAt, with reason EXPIRED. Returns how many it ended.
export const expireCardReaderPayments = async ({ now = new Date(), limit = 50 } = {}) => {
  const due = await TableSession.find({
    status: "paying",
    "paymentInProgress.kind": "card_reader",
    "paymentInProgress.expiresAt": { $lte: now },
  })
    .select("restaurantId")
    .limit(limit)
    .setOptions({ skipTenant: true })
    .lean();
  let ended = 0;
  for (const session of due) {
    const ctx = { restaurantId: session.restaurantId, requestId: "card-reader-expiry" };
    try {
      if ((await endCardReaderPayment(ctx, session._id, { reason: "EXPIRED", expiredBy: now })).ended) ended += 1;
    } catch (error) {
      logger.error({ sessionId: String(session._id), err: error }, "expiring a card reader payment failed");
      captureException(error);
    }
  }
  return ended;
};
