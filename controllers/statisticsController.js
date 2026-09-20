import Order from "../models/orders.model.js";

// Returns { query, error } - error is a ready-to-send 400 message when the
// date range is malformed or only half-supplied.
const parseDateRange = (start_date, end_date) => {
  if (Boolean(start_date) !== Boolean(end_date)) {
    return {
      error: "start_date and end_date must both be provided or both omitted",
    };
  }
  if (!start_date && !end_date) {
    return { query: {} };
  }
  const start = new Date(start_date);
  const end = new Date(end_date);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: "Invalid start_date or end_date" };
  }
  return { query: { createdAt: { $gte: start, $lte: end } } };
};

export const getTotalSales = async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const { query, error } = parseDateRange(start_date, end_date);
    if (error) {
      return res.status(400).json({ error });
    }
    if (!start_date && !end_date) {
      query.createdAt = {
        $lte: new Date(new Date().setDate(new Date().getDate() + 1)),
      };
    }

    const totalSales = await Order.aggregate([
      { $match: query },
      { $group: { _id: null, totalSales: { $sum: "$totalPrice" } } },
    ]);

    res.status(200).json({ totalSales: totalSales[0]?.totalSales || 0 });
  } catch (err) {
    next(err);
  }
};

export const getSalesByMenuItem = async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const { query, error } = parseDateRange(start_date, end_date);
    if (error) {
      return res.status(400).json({ error });
    }

    const sales = await Order.aggregate([
      { $match: query },
      { $unwind: "$menuItems" },
      {
        $lookup: {
          from: "menuitems",
          localField: "menuItems.product",
          foreignField: "_id",
          as: "menuItemDetails",
        },
      },
      { $unwind: "$menuItemDetails" },
      {
        $group: {
          _id: "$menuItems.product",
          totalSales: {
            $sum: {
              $multiply: ["$menuItems.quantity", "$menuItemDetails.price"],
            },
          },
          numSold: { $sum: "$menuItems.quantity" },
          menu_item: { $first: "$menuItemDetails.title" },
        },
      },
      {
        $project: {
          _id: 0,
          menu_item: 1,
          totalSales: 1,
          numSold: 1,
        },
      },
    ]);

    res.status(200).json(sales);
  } catch (err) {
    next(err);
  }
};

export const getOrdersByDate = async (req, res, next) => {
  try {
    const { start_date, end_date, group_by } = req.query;
    const { query, error } = parseDateRange(start_date, end_date);
    if (error) {
      return res.status(400).json({ error });
    }
    const groupByField =
      group_by === "month"
        ? { $dateToString: { format: "%Y-%m", date: "$createdAt" } }
        : { $dateToString: { format: "%d-%m-%Y", date: "$createdAt" } };

    const orders = await Order.aggregate([
      { $match: query },
      {
        $group: {
          _id: groupByField,
          ordersCount: { $sum: 1 },
          totalSales: { $sum: "$totalPrice" },
        },
      },
      { $sort: { _id: -1 } },
    ]);

    res.status(200).json(orders);
  } catch (err) {
    next(err);
  }
};

export const getUserOrdersByDate = async (req, res, next) => {
  try {
    const query = { user: req.params.id };

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .populate("menuItems.product");

    res.status(200).json(orders);
  } catch (err) {
    next(err);
  }
};

export const getTopCustomers = async (req, res, next) => {
  try {
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isNaN(parsedLimit)
      ? 10
      : Math.min(Math.max(parsedLimit, 1), 100);

    const topCustomers = await Order.aggregate([
      { $group: { _id: "$user", totalPrice: { $sum: "$totalPrice" } } },
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
          user: "$user.username",
          totalPrice: 1,
        },
      },
      { $sort: { totalPrice: -1 } },
      { $limit: limit },
    ]);

    res.status(200).json(topCustomers);
  } catch (err) {
    next(err);
  }
};
