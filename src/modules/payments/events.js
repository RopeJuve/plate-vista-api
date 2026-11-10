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
