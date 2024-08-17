import Order from "../models/orders.model.js";

export const getTotalSales = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const query = {};

    if (!start_date && !end_date) {
      query.createdAt = {
        $lte: new Date(new Date().setDate(new Date().getDate() + 1)),
      };
    }
    if (start_date && end_date) {
      query.createdAt = {
        $gte: new Date(start_date),
        $lte: new Date(end_date),
      };
    }

    const totalSales = await Order.aggregate([
      { $match: query },
      { $group: { _id: null, totalSales: { $sum: "$totalPrice" } } },
    ]);

    res.status(200).json({ totalSales: totalSales[0]?.totalSales || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}; //2024-08-16T21:25:46.623Z  2024-08-14T20:17:19.828Z

export const getSalesByMenuItem = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const query = {};

    if (start_date && end_date) {
      query.createdAt = {
        $gte: new Date(start_date),
        $lte: new Date(end_date),
      };
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
    res.status(500).json({ error: err.message });
  }
};

export const getOrdersByDate = async (req, res) => {
  try {
    const { start_date, end_date, group_by } = req.query;
    const query = {};
    const groupByField =
      group_by === "month"
        ? { $dateToString: { format: "%Y-%m", date: "$createdAt" } }
        : { $dateToString: { format: "%d-%m-%Y", date: "$createdAt" } };

    if (start_date && end_date) {
      query.createdAt = {
        $gte: new Date(start_date),
        $lte: new Date(end_date),
      };
    }

    const orders = await Order.aggregate([
      { $match: query },
      {
        $group: {
          _id: groupByField,
          ordersCount: { $sum: 1 },
          totalSales: { $sum: "$totalPrice" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.status(200).json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getUserOrdersByDate = async (req, res) => {
  try {
    const query = { user: req.params.id };

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .populate("menuItems.product");

    res.status(200).json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getTopCustomers = async (req, res) => {
  try {
    const { limit } = req.query;

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
      { $limit: parseInt(limit, 10) },
    ]);

    res.status(200).json(topCustomers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
