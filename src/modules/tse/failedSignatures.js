import Payment from "../payments/payment.model.js";
import Table from "../tables/table.model.js";
import { countFailedOrderSignatures, listFailedOrderSignatures } from "../ordering/order.signing.js";

// The signatures of a restaurant that failed, for the owner to see and push
// through by hand (#29): a payment's Kassenbeleg, an order's Bestellung, or
// one of its corrections. A correction is listed as kind ORDER under its
// order's id, since retrying the order signs its corrections too.

export const FAILED_LIST_LIMIT = 100;

// Failed payments + failed orders + failed corrections.
export const countFailedSignatures = async (restaurantId) => {
  const [payments, orders] = await Promise.all([
    Payment.countDocuments({ restaurantId, "tse.status": "FAILED" }),
    countFailedOrderSignatures(restaurantId),
  ]);
  return payments + orders;
};

// Newest first, at most FAILED_LIST_LIMIT. `error` is the stored
// `lastError`: fiskaly's code and message, never a secret.
export const listFailedSignatures = async (restaurantId) => {
  const [payments, orders] = await Promise.all([
    Payment.find({ restaurantId, "tse.status": "FAILED" })
      .sort({ paidAt: -1 })
      .limit(FAILED_LIST_LIMIT)
      .select("tableId paidAt amountCents tse.lastError tse.retryCount")
      .lean(),
    listFailedOrderSignatures(restaurantId),
  ]);
  const failed = [
    ...payments.map((payment) => ({
      kind: "PAYMENT",
      id: payment._id,
      tableId: payment.tableId,
      at: payment.paidAt,
      amountCents: payment.amountCents,
      error: payment.tse.lastError,
      retryCount: payment.tse.retryCount,
    })),
    ...orders.map((order) => ({ kind: "ORDER", ...order })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, FAILED_LIST_LIMIT);

  const tables = await Table.find({ restaurantId, _id: { $in: [...new Set(failed.map((item) => String(item.tableId)))] } })
    .select("tableNumber")
    .lean();
  const tableNumbers = new Map(tables.map((table) => [String(table._id), table.tableNumber]));
  return failed.map((item) => ({
    kind: item.kind,
    id: String(item.id),
    tableNumber: tableNumbers.get(String(item.tableId)) ?? null,
    at: new Date(item.at).toISOString(),
    amountCents: item.amountCents,
    error: item.error || null,
    retryCount: item.retryCount || 0,
  }));
};
