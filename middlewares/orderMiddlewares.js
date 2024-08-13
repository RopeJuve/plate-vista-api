import Order from "../models/orders.model.js";

export const checkOrderExists = async (req, res, next) => {
  const { id } = req.params;
  try {
    const order = await Order.findById(id)
      .populate("user")
      .populate("menuItems.product")
      .exec();
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    req.order = order;
    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
