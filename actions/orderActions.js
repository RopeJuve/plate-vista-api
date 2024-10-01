import MenuItem from "../models/menuItem.model.js";
import Order from "../models/orders.model.js";
import Table from "../models/table.model.js";
import {
  calculateTotal,
  populateMenuItem,
  updatedOrder,
} from "../utils/index.js";

export const createOrderAction = async (payload, broadcast, user, tableNum) => {
  try {
    const { menuItems } = payload;
    console.log(payload.user);
    const totalPrice = await calculateTotal(menuItems, MenuItem);
    const order = new Order({
      user: payload.user || null,
      menuItems,
      totalPrice,
    });
    await order.save();
    await order.populate("menuItems.product");
    const tableOrders = await Table.findOne({ tableNumber: tableNum });
    tableOrders.orders.push(order._id);
    tableOrders.status = "occupied";
    await tableOrders.save();
    await tableOrders.populate({
      path: "orders",
      populate: {
        path: "menuItems.product",
      },
    });
    console.log(order);
    user.state = order;
    broadcast(tableNum, tableOrders);
  } catch (err) {
    console.log(err);
  }
};

export const updateOrderAction = async (payload, broadcast, user, tableNum) => {
  try {
    const { orderId, menuItems } = payload;
    const orderUpdate = await Order.findById(orderId);
    const upO = await updatedOrder(orderUpdate, { menuItems }, MenuItem);
    await upO.populate("menuItems.product");
    const items = await populateMenuItem(menuItems, MenuItem);
    user.state = {
      menuItems: items,
    };
    broadcast(tableNum, upO);
  } catch (err) {
    console.log(err);
  }
};

export const changeStatusAction = async (
  payload,
  broadcast,
  user,
  tableNum
) => {
  try {
    const { orderId, status } = payload;
    const orderUpdate = await Order.findByIdAndUpdate(
      orderId,
      {
        orderStatus: status,
      },
      { new: true }
    );
    await orderUpdate.populate("menuItems.product");
    const tableOrders = await Table.findOne({ tableNumber: tableNum });
    await tableOrders.populate({
      path: "orders",
      populate: {
        path: "menuItems.product",
        match: { _id: { $ne: null } },
      },
    });
    user.state = {
      orderStatus: orderUpdate.orderStatus,
    };
    broadcast(tableNum, tableOrders);
  } catch (err) {
    console.log(err);
  }
};

export const deleteOrderAction = async (payload, broadcast, user, tableNum) => {
  try {
    const { orderId } = payload;
    await Order.findByIdAndDelete(orderId);
    user.state = {};
    broadcast(tableNum);
  } catch (err) {
    console.log(err);
  }
};
