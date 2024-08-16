import Order from "../models/orders.model.js";

export const getTotalSales = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const query = {};

    if(!start_date && !end_date){
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
            query.createdAt = { $gte: new Date(start_date), $lte: new Date(end_date) };
        }

        const sales = await Order.aggregate([
            { $match: query },
            { $unwind: "$menuItems" },  // Unwind the menuItems array
            { $group: { 
                _id: "$menuItems.product._id",  // Group by the product ID
                totalSales: { $sum: { $multiply: ["$menuItems.quantity", "$menuItems.product.price"] } },  // Calculate total sales
                numSold: { $sum: "$menuItems.quantity" }  // Sum up the quantity sold
            } },
            { $lookup: { 
                from: 'menuitems', 
                localField: '_id', 
                foreignField: '_id', 
                as: 'menu_item' 
            } },
            { $unwind: "$menu_item" },  // Unwind the resulting menu_item array
            { $project: { 
                menu_item: "$menu_item.title",  // Project the title of the menu item
                total_sales: 1, 
                units_sold: 1 
            } }
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
        const groupByField = group_by === 'month' ? { $dateToString: { format: "%Y-%m", date: "$createdAt" } } : { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } };

        if (start_date && end_date) {
            query.createdAt = { $gte: new Date(start_date), $lte: new Date(end_date) };
        }

        const orders = await Order.aggregate([
            { $match: query },
            { $group: { _id: groupByField, ordersCount: { $sum: 1 }, totalSales: { $sum: "$totalPrice" } } },
            { $sort: { _id: 1 } }
        ]);

        res.status(200).json(orders);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
