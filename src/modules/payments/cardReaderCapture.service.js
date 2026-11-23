import mongoose from "mongoose";
import { cancelCardReaderPaymentIntent, retrieveCardReaderPaymentDetails } from "../payouts/stripe.js";
import Payment from "./payment.model.js";
import { recordCardReaderPayment } from "./payment.service.js";
import { captureException, logger } from "../../shared/logger.js";

// The bill a card reader PaymentIntent was made for, from the metadata
// startCardReaderPayment gave it; null when it names none.
const billOf = (intent) => {
  const { restaurantId, sessionId } = intent?.metadata || {};
  if (!mongoose.isValidObjectId(restaurantId) || !mongoose.isValidObjectId(sessionId)) return null;
  return { restaurantId, sessionId };
};

const STRIPE_ACTOR = { type: "system", id: "stripe" };

// Stripe's `payment_intent.amount_capturable_updated`: the card was
// authorized on the reader. While the bill is still frozen for this
// PaymentIntent, it is captured and recorded as the bill's CARD_READER
// Payment, through the same path as every Payment. A repeated or late event
// replays (the PaymentIntent id is the clientPaymentId). An authorization
// the bill is not frozen for (cancelled, expired, paid another way, closed)
// is cancelled at Stripe and records nothing: never a Late Payment.
export const captureCardReaderAuthorization = async (event) => {
  const intent = event.data?.object;
  if (!intent?.id || !(intent.payment_method_types || []).includes("card_present")) return;
  const bill = billOf(intent);
  const log = { eventId: event.id, paymentIntentId: intent.id, ...bill };
  if (!bill) {
    logger.warn(log, "authorized card reader PaymentIntent names no bill; ignored");
    return;
  }
  const ctx = { restaurantId: bill.restaurantId, requestId: event.id, actor: STRIPE_ACTOR };
  let recorded;
  try {
    recorded = await recordCardReaderPayment(ctx, bill.sessionId, { paymentIntentId: intent.id, stripeAccountId: event.account });
  } catch (error) {
    if (error?.code === "VALIDATION") {
      logger.warn({ ...log, err: error }, "card reader authorization names a PaymentIntent used on another bill; ignored");
      return;
    }
    if (!["NOT_FROZEN_FOR_IT", "BILL_PAID", "NOT_FOUND"].includes(error?.code)) throw error;
    // Released, never captured (ADR-0008): the bill stopped waiting for this
    // card. A Stripe failure here fails the webhook, so Stripe sends it again.
    logger.warn({ ...log, err: error }, "card reader authorization for a bill not frozen for it; cancelling it");
    await cancelCardReaderPaymentIntent({ stripeAccountId: event.account, paymentIntentId: intent.id });
  }
  await keepCardPresentDetails(recorded?.payment, event.account, log);
};

// Keeps what the card receipt needs (brand, last 4, authorization code, AID,
// application label, read method) on the Payment. Best effort: the payment
// stands without it, and a redelivered event (which replays the Payment)
// tries again.
const keepCardPresentDetails = async (payment, stripeAccountId, log) => {
  if (!payment || payment.card) return;
  try {
    const card = await retrieveCardReaderPaymentDetails({ stripeAccountId, paymentIntentId: payment.clientPaymentId });
    if (!card) return;
    await Payment.updateOne({ _id: payment._id, restaurantId: payment.restaurantId }, { $set: { card } });
  } catch (error) {
    logger.error({ ...log, err: error }, "reading the card reader payment's card details from Stripe failed");
    captureException(error);
  }
};
