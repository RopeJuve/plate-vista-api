import { publish } from "../../realtime/events.js";
import { captureException, logger } from "../../shared/logger.js";

// Payment events for staff screens and the guest's table page
// (src/realtime/PROTOCOL.md 2.3). Fire-and-forget: a failed emit is logged,
// never thrown, so it can't fail a payment or a signing. Tests swap
// `paymentEvents.publish` to see a throwing publish.
export const paymentEvents = {
  publish: (envelope) => publish(envelope),
};

const send = (envelope) => {
  try {
    paymentEvents.publish(envelope);
  } catch (error) {
    logger.error(
      { restaurantId: String(envelope.restaurantId), event: envelope.message.event, err: error },
      "payment event publish failed"
    );
    captureException(error);
  }
};

const event = (event, data) => ({ type: "event", event, data });

export const publishBillPaid = (payment) =>
  send({
    restaurantId: payment.restaurantId,
    sessionId: payment.sessionId,
    message: event("bill.paid", {
      sessionId: String(payment.sessionId),
      paymentId: String(payment._id),
      receiptToken: payment.receiptToken,
      method: payment.method,
      totalCents: payment.amountCents,
    }),
  });

export const publishPaymentSigned = (payment) =>
  send({
    restaurantId: payment.restaurantId,
    sessionId: payment.sessionId,
    message: event("payment.signed", {
      paymentId: String(payment._id),
      receiptToken: payment.receiptToken,
    }),
  });

export const publishPaymentSignFailed = (payment) =>
  send({
    restaurantId: payment.restaurantId,
    sessionId: payment.sessionId,
    audience: "staff",
    message: event("payment.signFailed", { paymentId: String(payment._id) }),
  });

// The bill is frozen while a guest pays online or staff take a card reader
// payment (PROTOCOL 2.5, 2.7): `kind` is ONLINE or CARD_READER, and
// `readerName` names the reader for CARD_READER only.
export const publishBillFrozen = ({ restaurantId, sessionId, expiresAt, kind, readerName = null, totalCents }) =>
  send({
    restaurantId,
    sessionId,
    message: event("bill.frozen", {
      sessionId: String(sessionId),
      expiresAt: expiresAt.toISOString(),
      kind,
      readerName,
      totalCents,
    }),
  });

// The bill is open again without being paid (PROTOCOL 2.5, 2.7): `reason` is
// CANCELLED, EXPIRED, STAFF_PAYMENT or (card readers only) FAILED.
export const publishBillUnfrozen = ({ restaurantId, sessionId, reason }) =>
  send({
    restaurantId,
    sessionId,
    message: event("bill.unfrozen", { sessionId: String(sessionId), reason }),
  });

// A Late Payment was refunded (PROTOCOL 2.5); staff only.
export const publishOnlinePaymentRefunded = (restaurantId, refund) =>
  send({
    restaurantId,
    audience: "staff",
    message: event("online_payment.refunded", { refund }),
  });
