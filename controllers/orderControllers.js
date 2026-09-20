import MenuItem from "../models/menuItem.model.js";
import Order from "../models/orders.model.js";
import Table from "../models/table.model.js";
import {
  updatedOrder,
  calculateTotal,
  incrementSoldCounts,
  parsePagination,
  OrderError,
} from "../utils/index.js";

export const createOrder = async (req, res, next) => {
  try {
    const { menuItems } = req.body;
    // Never trust a client-supplied user; attribute the order to whoever
    // the token authenticated as (or nobody, for an employee-entered order).
    const userId = req.user.role === "user" ? req.user.id : null;

    const totalPrice = await calculateTotal(menuItems, MenuItem);
    const order = new Order({
      user: userId,
      menuItems,
      totalPrice,
    });
    await order.save();
    await incrementSoldCounts(menuItems, MenuItem);
    res.status(201).json(order);
  } catch (error) {
    if (error instanceof OrderError) {
      return res.status(error.status).json({ message: error.message });
    }
    next(error);
  }
};

export const getOrders = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [orders, total] = await Promise.all([
      Order.find()
        .populate("user", "username")
        .populate("menuItems.product")
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      Order.countDocuments(),
    ]);

    res.status(200).json({ orders, page, limit, total });
  } catch (error) {
    next(error);
  }
};

export const getOrder = async (req, res) => {
  return res.status(200).json(req.order);
};

export const updateOrder = async (req, res, next) => {
  try {
    const { order } = req;
    const newOrder = await updatedOrder(order, req.body, MenuItem);
    res.status(200).json(newOrder);
  } catch (error) {
    if (error instanceof OrderError) {
      return res.status(error.status).json({ message: error.message });
    }
    next(error);
  }
};

export const updateOrderStatus = async (req, res, next) => {
  try {
    const { order } = req;
    order.orderStatus = req.body.orderStatus;
    await order.save();
    res.status(200).json(order);
  } catch (error) {
    next(error);
  }
};

export const deleteOrder = async (req, res, next) => {
  try {
    await Order.findByIdAndDelete(req.order._id);
    await Table.updateMany(
      {},
      { $pull: { orders: req.order._id } }
    );
    res.status(200).json({ message: "Order deleted successfully" });
  } catch (error) {
    next(error);
  }
};
