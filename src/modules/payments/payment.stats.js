import mongoose from "mongoose";
import Payment, { PAYMENT_METHODS } from "./payment.model.js";
import { parseDateRange } from "../ordering/order.stats.js";

// How the dashboard groups payment methods: a card is a card, whether it was
// taken on a Card Reader or a Card Terminal.
const GROUPS = [
  { group: "CASH", methods: ["CASH"] },
  { group: "CARD", methods: ["CARD_TERMINAL", "CARD_READER"] },
  { group: "ONLINE", methods: ["ONLINE"] },
];

// What the restaurant took per payment method group in the range (by paidAt),
// each group naming the exact methods in it. Every group is listed, empty
// ones with 0; a method appears only when it was used.
export const getSalesByPaymentMethod = async (restaurantId, query) => {
  const { query: range, error } = parseDateRange(query.start_date, query.end_date);
  if (error) return { error };
  const rows = await Payment.aggregate([
    {
      $match: {
        restaurantId: new mongoose.Types.ObjectId(String(restaurantId)),
        ...(range.createdAt ? { paidAt: range.createdAt } : {}),
      },
    },
    { $group: { _id: "$method", count: { $sum: 1 }, totalCents: { $sum: "$amountCents" } } },
  ]);
  const byMethod = new Map(rows.map((row) => [row._id, row]));
  return GROUPS.map(({ group, methods }) => {
    const used = PAYMENT_METHODS.filter((method) => methods.includes(method) && byMethod.has(method)).map(
      (method) => ({ method, count: byMethod.get(method).count, totalCents: byMethod.get(method).totalCents })
    );
    return {
      group,
      count: used.reduce((sum, row) => sum + row.count, 0),
      totalCents: used.reduce((sum, row) => sum + row.totalCents, 0),
      methods: used,
    };
  });
};
