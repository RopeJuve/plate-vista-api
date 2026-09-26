import mongoose from "mongoose";
import Order from "./order.model.js";
import currency from "currency.js";
import { AppError } from "../../shared/errors.js";

const asId = (value) => new mongoose.Types.ObjectId(String(value));

const parseDateRange = (startDate, endDate) => {
  if (Boolean(startDate) !== Boolean(endDate)) {
    return { error: "start_date and end_date must both be provided or both omitted" };
  }
  if (!startDate && !endDate) return { query: {} };
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: "Invalid start_date or end_date" };
  }
  return { query: { createdAt: { $gte: start, $lte: end } } };
};

const activeMatch = (restaurantId, extra = {}) => ({
  restaurantId: asId(restaurantId),
  status: { $ne: "cancelled" },
  ...extra,
});

const major = (cents) => currency(cents || 0, { fromCents: true }).value;

export const getTotalSales = async (restaurantId, query) => {
  const { start_date: startDate, end_date: endDate } = query;
  const { query: range, error } = parseDateRange(startDate, endDate);
  if (error) return { error };
  const match = activeMatch(restaurantId, range);
  if (!startDate && !endDate) {
    match.createdAt = { $lte: new Date(Date.now() + 24 * 60 * 60 * 1000) };
  }
  const [row] = await Order.aggregate([
    { $match: match },
    { $group: { _id: null, totalCents: { $sum: "$totalCents" } } },
  ]);
  const totalCents = row?.totalCents || 0;
  return { totalCents, totalSales: major(totalCents) };
};

export const getSalesByMenuItem = async (restaurantId, query) => {
  const { query: range, error } = parseDateRange(query.start_date, query.end_date);
  if (error) return { error };
  return Order.aggregate([
    { $match: activeMatch(restaurantId, range) },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.productId",
        totalCents: { $sum: "$items.lineTotalCents" },
        numSold: { $sum: "$items.quantity" },
        menu_item: { $first: "$items.title" },
      },
    },
    {
      $project: {
        _id: 0,
        menu_item: 1,
        numSold: 1,
        totalCents: 1,
        totalSales: { $divide: ["$totalCents", 100] },
      },
    },
  ]);
};

export const getOrdersByDate = async (restaurantId, query) => {
  const { query: range, error } = parseDateRange(query.start_date, query.end_date);
  if (error) return { error };
  const groupByField =
    query.group_by === "month"
      ? { $dateToString: { format: "%Y-%m", date: "$createdAt" } }
      : { $dateToString: { format: "%d-%m-%Y", date: "$createdAt" } };
  const rows = await Order.aggregate([
    { $match: activeMatch(restaurantId, range) },
    {
      $group: {
        _id: groupByField,
        ordersCount: { $sum: 1 },
        totalCents: { $sum: "$totalCents" },
      },
    },
    { $sort: { _id: -1 } },
  ]);
  return rows.map((row) => ({
    ...row,
    totalSales: major(row.totalCents),
  }));
};

export const getUserOrders = async (restaurantId, userId) => {
  const orders = await Order.find({ restaurantId, userId, status: { $ne: "cancelled" } })
    .sort({ createdAt: -1 })
    .lean();
  if (orders.length === 0) throw new AppError("NOT_FOUND", "Not found", 404);
  return orders;
};

export const getTopCustomers = async (restaurantId, limit) => {
  const rows = await Order.aggregate([
    { $match: activeMatch(restaurantId, { userId: { $ne: null } }) },
    { $group: { _id: "$userId", totalCents: { $sum: "$totalCents" } } },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: "$user" },
    {
      $project: {
        _id: 0,
        user: "$user.username",
        totalCents: 1,
      },
    },
    { $sort: { totalCents: -1 } },
    { $limit: limit },
  ]);
  return rows.map((row) => ({ ...row, totalPrice: major(row.totalCents) }));
};
