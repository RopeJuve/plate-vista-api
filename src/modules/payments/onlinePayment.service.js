import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import Restaurant from "../restaurants/restaurant.model.js";
import Table from "../tables/table.model.js";
import TableSession from "../ordering/session.model.js";
import { getBillLines, getSessionBill } from "../ordering/order.service.js";
import { findSession } from "../ordering/session.service.js";
import { canPayBillOnline } from "../payouts/payout.service.js";
import { assertOnlinePaymentsConfigured, createOnlinePaymentCheckout } from "../payouts/stripe.js";
import { mergeReceiptLines } from "./money.js";
import { recordOnlinePayment } from "./payment.service.js";
import { publishBillFrozen, publishBillUnfrozen } from "./events.js";
import { isRefunded, refundLatePayment } from "./latePayment.service.js";
import { AppError } from "../../shared/errors.js";
import { captureException, logger } from "../../shared/logger.js";

// Stripe's shortest Checkout Session. Stripe counts it from when it creates
// the Checkout Session, a moment after the bill froze; the margin keeps the
// request above Stripe's minimum.
const EXPIRES_IN_MS = 30 * 60 * 1000;
const EXPIRY_MARGIN_MS = 30 * 1000;

const unavailable = () =>
  new AppError("ONLINE_PAYMENT_UNAVAILABLE", "Online payment is not available for this bill");

// Whole seconds, as Stripe keeps it, so the guest sees Stripe's own expiry.
const expiryFrom = (now) => new Date(Math.ceil((now + EXPIRES_IN_MS + EXPIRY_MARGIN_MS) / 1000) * 1000);

// The platform's cut of an online payment, from STRIPE_APPLICATION_FEE_BPS.
export const applicationFeeCents = (amountCents, bps = Number(process.env.STRIPE_APPLICATION_FEE_BPS) || 0) =>
  Math.round((amountCents * bps) / 10000);

const isRunning = (onlinePayment, now) => Boolean(onlinePayment) && onlinePayment.expiresAt.getTime() > now;

// Freezes an open bill that may be paid online, or finds the online payment
// someone at the table already started. Returns { attempt, froze, tableId }.
const freeze = async (ctx, sessionId) => {
  const mongoSession = await mongoose.startSession();
  try {
    return await mongoSession.withTransaction(async () => {
      const now = Date.now();
      const bill = await getSessionBill(ctx, sessionId, mongoSession);
      const session = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId })
        .select("status tableId onlinePayment")
        .session(mongoSession)
        .lean();
      if (session.status === "paying" && isRunning(session.onlinePayment, now)) {
        return { attempt: session.onlinePayment, froze: false, tableId: session.tableId };
      }
      if (!(await canPayBillOnline(ctx.restaurantId, bill))) throw unavailable();
      const attempt = { attemptId: randomUUID(), amountCents: bill.totalCents, expiresAt: expiryFrom(now) };
      // Writing the session makes an order or cancel racing this freeze
      // conflict, so one of them retries and sees the other.
      const result = await TableSession.updateOne(
        { _id: sessionId, restaurantId: ctx.restaurantId, status: "open" },
        { $set: { status: "paying", onlinePayment: attempt } }
      ).session(mongoSession);
      if (result.matchedCount === 0) throw unavailable();
      return { attempt, froze: true, tableId: session.tableId };
    });
  } finally {
    await mongoSession.endSession();
  }
};

// Puts the bill back to open, unless something else has moved it on since.
const unfreeze = (ctx, sessionId, attemptId) =>
  TableSession.updateOne(
    { _id: sessionId, restaurantId: ctx.restaurantId, status: "paying", "onlinePayment.attemptId": attemptId },
    { $set: { status: "open" }, $unset: { onlinePayment: 1 } }
  );

const tablePage = (slug, qrCode) =>
  `${process.env.GUEST_APP_URL.replace(/\/+$/, "")}/r/${slug}/t/${qrCode}`;

const checkoutFor = async (ctx, sessionId, attempt, tableId) => {
  const [restaurant, table, billLines] = await Promise.all([
    Restaurant.findById(ctx.restaurantId).select("slug payoutAccount.stripeAccountId").lean(),
    Table.findOne({ _id: tableId, restaurantId: ctx.restaurantId }).select("qrCode").lean(),
    getBillLines(ctx.restaurantId, sessionId),
  ]);
  const lines = mergeReceiptLines(billLines);
  const linesCents = lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
  if (linesCents !== attempt.amountCents) {
    throw new Error(`bill lines add up to ${linesCents}, not the bill's ${attempt.amountCents}`);
  }
  const page = tablePage(restaurant.slug, table.qrCode);
  return {
    stripeAccountId: restaurant.payoutAccount.stripeAccountId,
    attemptId: attempt.attemptId,
    lines,
    amountCents: attempt.amountCents,
    applicationFeeCents: applicationFeeCents(attempt.amountCents),
    expiresAt: attempt.expiresAt,
    successUrl: `${page}?payment=return`,
    cancelUrl: `${page}?payment=cancelled`,
    metadata: { restaurantId: String(ctx.restaurantId), sessionId: String(sessionId) },
  };
};

const present = (attempt) => ({ url: attempt.url, expiresAt: attempt.expiresAt.toISOString() });

// A guest at the table (or staff) starts paying the whole bill online. The
// bill freezes first, then Stripe makes the Checkout Session; anyone pressing
// pay again while it runs gets the same one.
export const startOnlinePayment = async (ctx, sessionId) => {
  await findSession(ctx.restaurantId, sessionId);
  assertOnlinePaymentsConfigured();
  const { attempt, froze, tableId } = await freeze(ctx, sessionId);
  if (attempt.url) return present(attempt);

  // Without a url yet, another request froze the bill and is still asking
  // Stripe, or never finished; the same attemptId gets Stripe's one Checkout
  // Session either way.
  let checkout;
  try {
    checkout = await createOnlinePaymentCheckout(await checkoutFor(ctx, sessionId, attempt, tableId));
  } catch (error) {
    logger.error(
      { restaurantId: String(ctx.restaurantId), sessionId: String(sessionId), requestId: ctx.requestId, err: error },
      "starting the online payment failed"
    );
    captureException(error);
    // Only the request that froze the bill unfreezes it: the other one's
    // request to Stripe may still succeed.
    if (froze) await unfreeze(ctx, sessionId, attempt.attemptId);
    throw new AppError("PAYMENT_PROVIDER_ERROR", "The payment provider could not start the online payment");
  }

  await TableSession.updateOne(
    { _id: sessionId, restaurantId: ctx.restaurantId, "onlinePayment.attemptId": attempt.attemptId },
    { $set: { "onlinePayment.checkoutSessionId": checkout.checkoutSessionId, "onlinePayment.url": checkout.url } }
  );
  if (froze) publishBillFrozen({ restaurantId: ctx.restaurantId, sessionId, expiresAt: attempt.expiresAt });
  return present({ ...attempt, url: checkout.url });
};

// The bill a Checkout Session was made for, from the metadata
// startOnlinePayment gave it; null when it names none.
const billOf = (checkout) => {
  const { restaurantId, sessionId } = checkout?.metadata || {};
  if (!mongoose.isValidObjectId(restaurantId) || !mongoose.isValidObjectId(sessionId)) return null;
  return { restaurantId, sessionId };
};

const STRIPE_ACTOR = { type: "system", id: "stripe" };

// A Late Payment is refunded in full and recorded. A failed refund is
// rethrown so the webhook answers 500 and Stripe delivers the event again.
const refundLate = async (event, bill, checkout, reason, log) => {
  logger.warn({ ...log, reason }, "late online payment; refunding");
  try {
    await refundLatePayment({ ...bill, checkout, stripeAccountId: event.account, reason });
  } catch (error) {
    logger.error({ ...log, reason, err: error }, "refunding a late online payment failed");
    captureException(error);
    throw error;
  }
};

// Stripe's `checkout.session.completed`: the guest has paid, so the webhook,
// and only the webhook, records the online Payment. A payment that cannot
// pay the bill is a Late Payment and is refunded.
export const completeOnlinePayment = async (event) => {
  const checkout = event.data?.object;
  if (checkout?.payment_status !== "paid") return;
  const bill = billOf(checkout);
  const log = { eventId: event.id, checkoutSessionId: checkout.id, ...bill };
  if (!bill) {
    logger.warn(log, "paid Checkout Session names no bill; ignored");
    return;
  }
  // Refunded already: a redelivered event changes nothing.
  if (await isRefunded(bill.restaurantId, checkout.id)) return;
  const ctx = { restaurantId: bill.restaurantId, requestId: event.id, actor: STRIPE_ACTOR };
  try {
    await recordOnlinePayment(ctx, bill.sessionId, checkout.id);
  } catch (error) {
    if (error?.code === "LATE_PAYMENT") {
      await refundLate(event, bill, checkout, error.details.reason, log);
      return;
    }
    if (error?.code === "NOT_FOUND" || error?.code === "VALIDATION") {
      logger.warn({ ...log, err: error }, "paid Checkout Session for an unknown bill; ignored");
      return;
    }
    throw error;
  }
};

// Stripe's `checkout.session.expired`: the guest never paid, so the bill
// frozen for this Checkout Session opens again. An old or other Checkout
// Session changes nothing.
export const expireOnlinePayment = async (event) => {
  const checkout = event.data?.object;
  const bill = billOf(checkout);
  if (!bill || !checkout.id) return;
  const result = await TableSession.updateOne(
    {
      _id: bill.sessionId,
      restaurantId: bill.restaurantId,
      status: "paying",
      "onlinePayment.checkoutSessionId": checkout.id,
    },
    { $set: { status: "open" }, $unset: { onlinePayment: 1 } }
  );
  if (result.modifiedCount > 0) publishBillUnfrozen(bill);
};
