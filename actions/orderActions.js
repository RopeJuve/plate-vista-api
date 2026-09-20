import MenuItem from "../models/menuItem.model.js";
import Order from "../models/orders.model.js";
import Table from "../models/table.model.js";
import { ORDER_STATUSES } from "../utils/orderStatuses.js";
import {
  calculateTotal,
  incrementSoldCounts,
  updatedOrder,
  assertValidMenuItems,
  OrderError,
} from "../utils/index.js";

const sendError = (connection, message) => {
  if (connection && connection.readyState === connection.OPEN) {
    connection.send(JSON.stringify({ type: "error", payload: message }));
  }
};

const orderBelongsToTable = async (orderId, tableNum) => {
  const table = await Table.findOne({ tableNumber: tableNum });
  if (!table) return false;
  return table.orders.some((id) => id.toString() === orderId);
};

export const createOrderAction = async (
  payload,
  broadcast,
  identity,
  tableNum,
  connection
) => {
  try {
    const { menuItems } = payload || {};
    assertValidMenuItems(menuItems);

    const table = await Table.findOne({ tableNumber: tableNum });
    if (!table) {
      return sendError(connection, "Table not found");
    }

    const totalPrice = await calculateTotal(menuItems, MenuItem);
    const order = new Order({
      user: identity?.userId || null,
      menuItems,
      totalPrice,
    });
    await order.save();
    await incrementSoldCounts(menuItems, MenuItem);
    await order.populate("menuItems.product");

    const updatedTable = await Table.findOneAndUpdate(
      { tableNumber: tableNum },
      { $push: { orders: order._id }, $set: { status: "occupied" } },
      { new: true }
    ).populate({
      path: "orders",
      populate: { path: "menuItems.product" },
    });

    broadcast(tableNum, updatedTable);
  } catch (err) {
    console.error(err);
    sendError(connection, err instanceof OrderError ? err.message : "Failed to create order");
  }
};

export const updateOrderAction = async (
  payload,
  broadcast,
  identity,
  tableNum,
  connection,
  role
) => {
  try {
    const { orderId, menuItems } = payload || {};
    if (!orderId) {
      return sendError(connection, "orderId is required");
    }
    assertValidMenuItems(menuItems);

    if (role !== "employee" && !(await orderBelongsToTable(orderId, tableNum))) {
      return sendError(connection, "Order does not belong to this table");
    }

    const orderUpdate = await Order.findById(orderId);
    if (!orderUpdate) {
      return sendError(connection, "Order not found");
    }

    const upO = await updatedOrder(orderUpdate, { menuItems }, MenuItem);
    await upO.populate("menuItems.product");
    broadcast(tableNum, upO);
  } catch (err) {
    console.error(err);
    sendError(connection, err instanceof OrderError ? err.message : "Failed to update order");
  }
};

export const changeStatusAction = async (
  payload,
  broadcast,
  identity,
  tableNum,
  connection
) => {
  try {
    const { orderId, status } = payload || {};
    if (!ORDER_STATUSES.includes(status)) {
      return sendError(connection, "Invalid order status");
    }

    const orderUpdate = await Order.findByIdAndUpdate(
      orderId,
      { orderStatus: status },
      { new: true, runValidators: true }
    );
    if (!orderUpdate) {
      return sendError(connection, "Order not found");
    }
    await orderUpdate.populate("menuItems.product");

    const targetTableNum = tableNum || payload.tableNum;
    if (!targetTableNum) {
      return sendError(connection, "tableNum is required");
    }
    const tableOrders = await Table.findOne({ tableNumber: targetTableNum });
    if (!tableOrders) {
      return sendError(connection, "Table not found");
    }
    await tableOrders.populate({
      path: "orders",
      populate: { path: "menuItems.product", match: { _id: { $ne: null } } },
    });
    broadcast(targetTableNum, tableOrders);
  } catch (err) {
    console.error(err);
    sendError(connection, "Failed to change order status");
  }
};

export const deleteOrderAction = async (
  payload,
  broadcast,
  identity,
  tableNum,
  connection
) => {
  try {
    const { orderId } = payload || {};
    const deleted = await Order.findByIdAndDelete(orderId);
    if (!deleted) {
      return sendError(connection, "Order not found");
    }
    await Table.updateMany({}, { $pull: { orders: orderId } });
    broadcast(tableNum);
  } catch (err) {
    console.error(err);
    sendError(connection, "Failed to delete order");
  }
};
