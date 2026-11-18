import { z } from "zod";
import OnlinePaymentRefund from "./onlinePaymentRefund.model.js";
import Restaurant from "../restaurants/restaurant.model.js";
import Table from "../tables/table.model.js";
import TableSession from "../ordering/session.model.js";
import { refundOnlinePayment } from "../payouts/stripe.js";
import { publishOnlinePaymentRefunded } from "./events.js";
import { parseOrThrow } from "../../shared/validate.js";
import { toIso as iso } from "../../shared/iso.js";

const isDuplicateKey = (error) => error?.code === 11000;

export const serializeRefund = (refund) => ({
  id: String(refund._id),
  sessionId: String(refund.sessionId),
  tableNumber: refund.tableNumber ?? null,
  amountCents: refund.amountCents,
  reason: refund.reason,
  refundedAt: iso(refund.refundedAt),
});

// True when this Checkout Session's Late Payment was refunded already.
export const isRefunded = async (restaurantId, checkoutSessionId) =>
  Boolean(await OnlinePaymentRefund.exists({ restaurantId, checkoutSessionId }));

// Refunds a Late Payment (GLOSSARY.md) in full and records it; never a
// Payment. A refund Stripe fails throws, so the webhook answers 500 and
// Stripe delivers again; the idempotency key keeps that to one refund.
export const refundLatePayment = async ({ restaurantId, sessionId, checkout, stripeAccountId, reason }) => {
  const [restaurant, session] = await Promise.all([
    Restaurant.findById(restaurantId).select("payoutAccount.stripeAccountId").lean(),
    TableSession.findOne({ _id: sessionId, restaurantId }).select("tableId").lean(),
  ]);
  await refundOnlinePayment({
    stripeAccountId: stripeAccountId || restaurant?.payoutAccount?.stripeAccountId,
    paymentIntentId: checkout.payment_intent,
    checkoutSessionId: checkout.id,
  });
  const table = await Table.findOne({ _id: session.tableId, restaurantId }).select("tableNumber").lean();
  let refund;
  try {
    refund = await OnlinePaymentRefund.create({
      restaurantId,
      sessionId,
      tableId: session.tableId,
      tableNumber: table?.tableNumber,
      checkoutSessionId: checkout.id,
      paymentIntentId: checkout.payment_intent,
      amountCents: checkout.amount_total,
      reason,
      refundedAt: new Date(),
    });
  } catch (error) {
    // A concurrent delivery of the same event recorded it first.
    if (isDuplicateKey(error)) return null;
    throw error;
  }
  const item = serializeRefund(refund);
  publishOnlinePaymentRefunded(restaurantId, item);
  return item;
};

export const LIST_LIMIT_DEFAULT = 50;

const listSchema = z.object({
  limit: z.coerce
    .number({ error: "limit must be a number" })
    .int({ error: "limit must be a whole number" })
    .min(1, { error: "limit must be 1 to 100" })
    .max(100, { error: "limit must be 1 to 100" })
    .default(LIST_LIMIT_DEFAULT),
  before: z.iso.datetime({ offset: true, error: "before must be an ISO-8601 date" }).optional(),
});

// The restaurant's refunded Late Payments, newest first; pass nextBefore as
// `before` for the next page, null when there is none.
export const listOnlinePaymentRefunds = async (restaurantId, query) => {
  const { limit, before } = parseOrThrow(listSchema, query);
  const filter = { restaurantId };
  if (before) filter.refundedAt = { $lt: new Date(before) };
  const refunds = await OnlinePaymentRefund.find(filter).sort({ refundedAt: -1, _id: -1 }).limit(limit).lean();
  const items = refunds.map(serializeRefund);
  return { items, nextBefore: items.length === limit ? items[items.length - 1].refundedAt : null };
};
