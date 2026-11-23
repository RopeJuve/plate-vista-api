import TableSession, { PAYMENT_IN_PROGRESS_KIND } from "../ordering/session.model.js";
import { expireOnlinePaymentCheckout } from "../payouts/stripe.js";
import { publishBillUnfrozen } from "./events.js";
import { reconcileOnlinePayment } from "./onlinePayment.service.js";
import { endCardReaderPayment } from "./cardReaderPaymentEnd.js";
import { reopenFrozenBill, sessionStatusOf, UNFREEZE_REASON } from "./billFreeze.js";
import { stripeAccountOf } from "./stripeContext.js";
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
// `reason` is bill.unfrozen's: CANCELLED, or STAFF_PAYMENT for a staff
// payment or close. A card reader payment is left alone here
// (cardReaderPaymentEnd.js ends those; endPaymentInProgress ends either).
// Returns { status } of the session afterwards.
export const unfreezeBill = async (
  ctx,
  sessionId,
  { evenIfStripeFails = false, reason = UNFREEZE_REASON.CANCELLED } = {}
) => {
  const session = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId })
    .select("status paymentInProgress")
    .lean();
  if (!session) throw new AppError("NOT_FOUND", "Not found", 404);
  // Only an online payment is ever in progress today.
  if (session.status !== "paying" || session.paymentInProgress?.kind !== PAYMENT_IN_PROGRESS_KIND.ONLINE) {
    return { status: session.status };
  }

  const { attemptId, checkoutSessionId } = session.paymentInProgress;
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
      outcome = await expireOnlinePaymentCheckout({
        stripeAccountId: await stripeAccountOf(ctx.restaurantId),
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
      return { status: await sessionStatusOf(ctx.restaurantId, sessionId) };
    }
  }

  // Only this online payment's freeze: something else may have moved it on.
  if (await reopenFrozenBill({ restaurantId: ctx.restaurantId, sessionId, attemptId })) {
    publishBillUnfrozen({ restaurantId: ctx.restaurantId, sessionId, reason });
    return { status: "open" };
  }
  return { status: await sessionStatusOf(ctx.restaurantId, sessionId) };
};

// Staff win (GLOSSARY.md, Bill): before staff record a payment or close the
// table, whatever payment the bill is frozen for ends, online or on a card
// reader, with reason STAFF_PAYMENT, even when Stripe cannot be reached. A
// payment Stripe has already taken is recorded instead, so the staff
// payment then answers BILL_PAID; an online one Stripe cannot confirm
// throws BILL_PAYING_ONLINE (unfreezeBill).
export const endPaymentInProgress = async (ctx, sessionId) => {
  await unfreezeBill(ctx, sessionId, { evenIfStripeFails: true, reason: UNFREEZE_REASON.STAFF_PAYMENT });
  await endCardReaderPayment(ctx, sessionId, { reason: UNFREEZE_REASON.STAFF_PAYMENT });
};
