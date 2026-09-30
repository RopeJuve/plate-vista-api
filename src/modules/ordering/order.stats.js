import mongoose from "mongoose";
import Order from "./order.model.js";
import currency from "currency.js";
import { AppError } from "../../shared/errors.js";
import Restaurant from "../restaurants/restaurant.model.js";

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

// Days start at midnight where the restaurant is, not in UTC: an order at
// 00:30 in Berlin belongs to that day's sales.
const timezoneOf = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("settings.timezone").lean();
  return restaurant?.settings?.timezone || "UTC";
};

const dateKey = (format, timezone) => ({
  $dateToString: { format, date: "$createdAt", timezone },
});

const parseLimit = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, 1), 100);
};

// Best sellers first; ties go to the bigger revenue, then the name.
const bestSellersFirst = { numSold: -1, totalCents: -1, menu_item: 1 };

// One document per line that was sold: lines of a cancelled ticket are left
// out even when the rest of their order went ahead.
const soldLines = [{ $unwind: "$items" }, { $match: { "items.status": { $ne: "cancelled" } } }];

const groupByMenuItem = {
  $group: {
    _id: "$items.productId",
    totalCents: { $sum: "$items.lineTotalCents" },
    numSold: { $sum: "$items.quantity" },
    menu_item: { $first: "$items.title" },
  },
};

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
    ...soldLines,
    groupByMenuItem,
    { $sort: bestSellersFirst },
    { $limit: parseLimit(query.limit, 100) },
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

// The dashboard's report card: what the restaurant took in the range.
export const getSummary = async (restaurantId, query) => {
  const { query: range, error } = parseDateRange(query.start_date, query.end_date);
  if (error) return { error };
  const [result] = await Order.aggregate([
    { $match: activeMatch(restaurantId, range) },
    {
      $facet: {
        orders: [{ $group: { _id: null, count: { $sum: 1 }, totalCents: { $sum: "$totalCents" } } }],
        items: [
          ...soldLines,
          groupByMenuItem,
          { $sort: bestSellersFirst },
          { $group: { _id: null, itemsSold: { $sum: "$numSold" }, top: { $first: "$$ROOT" } } },
        ],
      },
    },
  ]);
  const orders = result.orders[0];
  const items = result.items[0];
  const ordersCount = orders?.count || 0;
  const totalCents = orders?.totalCents || 0;
  return {
    ordersCount,
    totalCents,
    averageOrderCents: ordersCount ? Math.round(totalCents / ordersCount) : 0,
    itemsSold: items?.itemsSold || 0,
    topItem: items
      ? { menu_item: items.top.menu_item, numSold: items.top.numSold, totalCents: items.top.totalCents }
      : null,
  };
};

// Items sold per day (or month) and menu category. Orders placed before line
// items kept their category fall back to the menu item's current category.
export const getSalesByCategory = async (restaurantId, query) => {
  const { query: range, error } = parseDateRange(query.start_date, query.end_date);
  if (error) return { error };
  const timezone = await timezoneOf(restaurantId);
  return Order.aggregate([
    { $match: activeMatch(restaurantId, range) },
    ...soldLines,
    {
      $lookup: {
        from: "menuitems",
        let: { productId: "$items.productId" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$productId"] },
                  { $eq: ["$restaurantId", asId(restaurantId)] },
                ],
              },
            },
          },
          {
            $lookup: {
              from: "categories",
              localField: "categoryId",
              foreignField: "_id",
              as: "category",
            },
          },
          { $project: { _id: 0, category: { $first: "$category.name" } } },
        ],
        as: "menuItem",
      },
    },
    {
      $group: {
        _id: {
          date: dateKey(query.group_by === "month" ? "%Y-%m" : "%Y-%m-%d", timezone),
          category: { $ifNull: ["$items.category", { $first: "$menuItem.category" }, "Other"] },
        },
        numSold: { $sum: "$items.quantity" },
        totalCents: { $sum: "$items.lineTotalCents" },
      },
    },
    { $sort: { "_id.date": 1, "_id.category": 1 } },
    {
      $project: {
        _id: 0,
        date: "$_id.date",
        category: "$_id.category",
        numSold: 1,
        totalCents: 1,
      },
    },
  ]);
};

// One row per day ("2026-09-29") or month ("2026-09"), oldest first.
export const getOrdersByDate = async (restaurantId, query) => {
  const { query: range, error } = parseDateRange(query.start_date, query.end_date);
  if (error) return { error };
  const timezone = await timezoneOf(restaurantId);
  const format = query.group_by === "month" ? "%Y-%m" : "%Y-%m-%d";
  const rows = await Order.aggregate([
    { $match: activeMatch(restaurantId, range) },
    {
      $group: {
        _id: dateKey(format, timezone),
        ordersCount: { $sum: 1 },
        totalCents: { $sum: "$totalCents" },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((row) => ({
    date: row._id,
    ordersCount: row.ordersCount,
    totalCents: row.totalCents,
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
