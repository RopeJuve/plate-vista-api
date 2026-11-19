import Restaurant from "../restaurants/restaurant.model.js";
import TableSession from "../ordering/session.model.js";
import { expireOnlinePaymentCheckout } from "../payouts/stripe.js";
import { publishBillUnfrozen } from "./events.js";
import { reconcileOnlinePayment } from "./onlinePayment.service.js";
import { AppError } from "../../shared/errors.js";
import { captureException, logger } from "../../shared/logger.js";

const payingOnline = () =>
  new AppError("BILL_PAYING_ONLINE", "The guest has just paid online; wait for the payment to arrive");

// Stops the online payment a frozen bill is waiting for (GLOSSARY.md, Bill):
// Stripe expires the Checkout Session first, then the session is `open`
// again and `bill.unfrozen` goes out. A bill that is not frozen is left as
// it is. When Stripe says the guest has paid already, nothing changes and
// it throws BILL_PAYING_ONLINE: the webhook records that Payment.
//
// Staff always win: with `evenIfStripeFails` a Stripe failure is logged and
// the bill unfreezes anyway; a payment that still completes is a Late
// Payment and is refunded. Without it the failure throws
// PAYMENT_PROVIDER_ERROR and the bill stays frozen.
// Returns { status } of the session afterwards.
export const unfreezeBill = async (ctx, sessionId, { evenIfStripeFails = false } = {}) => {
  const session = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId })
    .select("status onlinePayment")
    .lean();
  if (!session) throw new AppError("NOT_FOUND", "Not found", 404);
  if (session.status !== "paying" || !session.onlinePayment) return { status: session.status };

  const { attemptId, checkoutSessionId } = session.onlinePayment;
  // Without a Checkout Session id, Stripe has not made one yet, or never did.
  if (checkoutSessionId) {
    const log = {
      restaurantId: String(ctx.restaurantId),
      sessionId: String(sessionId),
      checkoutSessionId,
      requestId: ctx.requestId,
    };
    let outcome;
    try {
      const restaurant = await Restaurant.findById(ctx.restaurantId).select("payoutAccount.stripeAccountId").lean();
      outcome = await expireOnlinePaymentCheckout({
        stripeAccountId: restaurant?.payoutAccount?.stripeAccountId,
        checkoutSessionId,
      });
    } catch (error) {
      logger.error({ ...log, err: error }, "expiring the Checkout Session failed");
      captureException(error);
      if (!evenIfStripeFails) {
        throw new AppError("PAYMENT_PROVIDER_ERROR", "The payment provider could not stop the online payment");
      }
    }
    if (outcome === "complete") {
      let recorded = false;
      try {
        recorded = await reconcileOnlinePayment(ctx.restaurantId, sessionId);
      } catch (error) {
        logger.error({ ...log, err: error }, "recording the completed online payment failed");
        captureException(error);
      }
      if (!recorded) throw payingOnline();
      const after = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId })
        .select("status")
        .lean();
      return { status: after.status };
    }
  }

  // Only this online payment's freeze: something else may have moved it on.
  const result = await TableSession.updateOne(
    { _id: sessionId, restaurantId: ctx.restaurantId, status: "paying", "onlinePayment.attemptId": attemptId },
    { $set: { status: "open" }, $unset: { onlinePayment: 1 } }
  );
  if (result.modifiedCount > 0) {
    publishBillUnfrozen({ restaurantId: ctx.restaurantId, sessionId });
    return { status: "open" };
  }
  const now = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId }).select("status").lean();
  return { status: now.status };
};
