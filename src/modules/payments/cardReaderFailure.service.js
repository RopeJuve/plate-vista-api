import Restaurant from "../restaurants/restaurant.model.js";
import TableSession from "../ordering/session.model.js";
import { tableNumbersOf } from "../tables/tableNumbers.js";
import { CARD_READER_ATTEMPT, reopenFrozenBill, UNFREEZE_REASON } from "./billFreeze.js";
import { retrieveCardReaderPaymentIntent } from "../payouts/stripe.js";
import { publishBillPaymentFailed, publishBillUnfrozen } from "./events.js";
import { captureException, logger } from "../../shared/logger.js";

// The contract's PaymentFailureReason, each with the sentence staff read.
const MESSAGES = {
  DECLINED: "The card was declined.",
  INSUFFICIENT_FUNDS: "The card was declined for insufficient funds.",
  LOST_OR_STOLEN_CARD: "The card was declined because it was reported lost or stolen.",
  EXPIRED_CARD: "The card has expired.",
  PROCESSING_ERROR: "The card could not be processed; trying again may work.",
  CANCELLED_ON_READER: "The payment was cancelled on the reader.",
  READER_OFFLINE: "The reader lost its connection during the payment.",
  OTHER: "The reader could not take the payment.",
};

const failure = (reason, message = MESSAGES[reason]) => ({ reason, message });

// Why Stripe failed the card, from the PaymentIntent's last_payment_error.
const fromPaymentError = (error) => {
  const code = error?.decline_code || error?.code;
  if (code === "insufficient_funds") return failure("INSUFFICIENT_FUNDS");
  if (code === "lost_card" || code === "stolen_card") return failure("LOST_OR_STOLEN_CARD");
  if (code === "expired_card") return failure("EXPIRED_CARD");
  if (code === "processing_error") return failure("PROCESSING_ERROR");
  return failure("DECLINED");
};

// Why the reader's action failed, from its failure_code.
const fromReaderFailure = (code = "") => {
  if (code === "card_declined") return failure("DECLINED");
  if (/cancel/.test(code)) return failure("CANCELLED_ON_READER");
  if (/offline|connect|unreachable/.test(code)) return failure("READER_OFFLINE");
  if (/time/.test(code)) return failure("OTHER", "The reader timed out waiting for the card.");
  return failure("OTHER");
};

// What a failure event says: the PaymentIntent whose card reader attempt
// failed, and Stripe's reason. Null for events that are not about one.
const failedAttemptOf = (event) => {
  const object = event.data?.object;
  if (event.type === "payment_intent.payment_failed") {
    if (!object?.id || !(object.payment_method_types || []).includes("card_present")) return null;
    return { paymentIntentId: object.id, paymentError: object.last_payment_error };
  }
  const action = object?.action;
  if (action?.type !== "process_payment_intent" || action.status !== "failed") return null;
  const paymentIntentId = action.process_payment_intent?.payment_intent;
  return paymentIntentId ? { paymentIntentId, readerFailureCode: action.failure_code } : null;
};

// A declined card reported by the reader names no reason beyond the
// decline; the PaymentIntent knows more, when Stripe can be read.
const reasonOf = async ({ paymentError, readerFailureCode, paymentIntentId }, stripeAccountId, log) => {
  if (paymentError) return fromPaymentError(paymentError);
  if (readerFailureCode === "card_declined") {
    try {
      const intent = await retrieveCardReaderPaymentIntent({ stripeAccountId, paymentIntentId });
      if (intent.lastPaymentError) return fromPaymentError(intent.lastPaymentError);
    } catch (error) {
      logger.warn({ ...log, err: error }, "reading the declined PaymentIntent failed; reason DECLINED");
      captureException(error);
    }
  }
  return fromReaderFailure(readerFailureCode);
};

// A retry can use the same PaymentIntent again, so a failure event for it
// may be the earlier try's. Stripe dates events to the second and they carry
// nothing else that tells the tries apart: on a PaymentIntent used again, a
// failure dated in or before the second the retry started is the earlier
// try's. (A card that fails within that same second is missed; the attempt
// then expires.) A PaymentIntent made for this attempt is only its own.
const isEarlierTrys = (event, attempt) => {
  const reused = Boolean(attempt.reusablePaymentIntentId) && attempt.paymentIntentId === attempt.reusablePaymentIntentId;
  return reused && Boolean(event.created) && event.created <= Math.floor(attempt.startedAt.getTime() / 1000);
};

// Stripe's `payment_intent.payment_failed` and `terminal.reader.action_failed`:
// the card was declined or the reader failed. While the bill is still frozen
// for this PaymentIntent, the attempt ends as FAILED with a reason staff can
// read: the bill is open again, keeps the failed attempt for Retry, and
// `bill.paymentFailed` then `bill.unfrozen` (FAILED) go out. Stripe often
// sends both events for one decline; the first ends the attempt and the
// second, a repeat, or one for an attempt that ended, changes nothing.
export const failCardReaderAttempt = async (event) => {
  const failed = failedAttemptOf(event);
  if (!failed || !event.account) return;
  const log = { eventId: event.id, type: event.type, paymentIntentId: failed.paymentIntentId };
  const restaurant = await Restaurant.findOne({ "payoutAccount.stripeAccountId": event.account }).select("_id").lean();
  if (!restaurant) {
    logger.warn(log, "card reader failure for an unknown Payout Account; ignored");
    return;
  }
  const restaurantId = restaurant._id;
  const session = await TableSession.findOne({
    restaurantId,
    ...CARD_READER_ATTEMPT,
    "paymentInProgress.paymentIntentId": failed.paymentIntentId,
  })
    .select("tableId paymentInProgress")
    .lean();
  const attempt = session?.paymentInProgress;
  if (!attempt || isEarlierTrys(event, attempt)) {
    logger.info(log, "card reader failure for an attempt that has ended; ignored");
    return;
  }

  const failure = await reasonOf(failed, event.account, log);
  const failedAt = new Date();
  const reopened = await reopenFrozenBill({
    restaurantId,
    sessionId: session._id,
    attemptId: attempt.attemptId,
    set: { failedCardReaderPayment: { ...attempt, failure, failedAt } },
  });
  if (!reopened) return;

  const tableNumbers = await tableNumbersOf(restaurantId, [session.tableId]);
  publishBillPaymentFailed({
    restaurantId,
    sessionId: session._id,
    tableNumber: tableNumbers.get(String(session.tableId)) ?? null,
    readerName: attempt.readerName,
    amountCents: attempt.amountCents,
    failure,
    failedAt,
  });
  publishBillUnfrozen({ restaurantId, sessionId: session._id, reason: UNFREEZE_REASON.FAILED });
};
