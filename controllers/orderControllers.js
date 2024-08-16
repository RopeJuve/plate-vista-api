import MenuItem from "../models/menuItem.model.js";
import Order from "../models/orders.model.js";
import { updatedOrder, calculateTotal } from "../utils/index.js";

export const createOrder = async (req, res) => {
  try {
    const { user, menuItems } = req.body;
    const totalPrice = await calculateTotal(menuItems, MenuItem);
    if (totalPrice === 0) {
      return res.status(404).json({ message: "MenuItem not found" });
    }

    const order = new Order({
      user: user || null,
      menuItems,
      totalPrice,
    });
    await order.save();
    res.status(201).json(order);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getOrders = async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("user")
      .populate("menuItems.product")
      .exec();

    res.status(200).json(orders);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getOrder = async (req, res) => {
  return res.status(200).json(req.order);
};

export const updateOrder = async (req, res) => {
  try {
    const { order } = req;
    const newOrder = await updatedOrder(order, req.body, MenuItem);
    res.status(200).json(newOrder);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteOrder = async (req, res) => {
  try {
    await Order.findByIdAndDelete(req.order._id);
    res.status(200).json({ message: "Order deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
