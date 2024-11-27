import {
  calculateTotal,
  populateMenuItem,
  updatedOrder,
} from "../utils/index.js";

export const createOrderAction = async (
  payload,
  broadcast,
  user,
  tableNum,
  dbConnection
) => {
  try {
    const { menuItems } = payload;
    console.log(payload.user);
    const totalPrice = await calculateTotal(menuItems, dbConnection);
    const order = dbConnection.model("Order")({
      user: payload.user || null,
      menuItems,
      totalPrice,
    });
    await order.save();
    await order.populate("menuItems.product");
    const tableOrders = await dbConnection
      .model("Table")
      .findOne({ tableNumber: tableNum });
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
    broadcast(tableNum, tableOrders, dbConnection);
  } catch (err) {
    console.log(err);
  }
};

export const updateOrderAction = async (
  payload,
  broadcast,
  user,
  tableNum,
  dbConnection
) => {
  try {
    const { orderId, menuItems } = payload;
    const orderUpdate = await dbConnection.model("Order").findById(orderId);
    const upO = await updatedOrder(orderUpdate, { menuItems }, dbConnection);
    await upO.populate("menuItems.product");
    const items = await populateMenuItem(menuItems, dbConnection);
    user.state = {
      menuItems: items,
    };
    broadcast(tableNum, upO, dbConnection);
  } catch (err) {
    console.log(err);
  }
};

export const changeStatusAction = async (
  payload,
  broadcast,
  user,
  tableNum,
  dbConnection
) => {
  try {
    const { orderId, status } = payload;
    const orderUpdate = await dbConnection.model("Order").findByIdAndUpdate(
      orderId,
      {
        orderStatus: status,
      },
      { new: true }
    );
    await orderUpdate.populate("menuItems.product");
    if (tableNum) {
      const tableOrders = await dbConnection
        .model("Table")
        .findOne({ tableNumber: tableNum });
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
      broadcast(tableNum, tableOrders, dbConnection);
    } else {
      const tableOrders = await dbConnection.model("Table").findOne({
        tableNumber: payload.tableNum,
      });
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
      broadcast(payload.tableNum, tableOrders, dbConnection);
    }
  } catch (err) {
    console.log(err);
  }
};

export const deleteOrderAction = async (
  payload,
  broadcast,
  user,
  tableNum,
  dbConnection
) => {
  try {
    const { orderId } = payload;
    await dbConnection.model("Order").findByIdAndDelete(orderId);
    user.state = {};
    broadcast(tableNum, dbConnection);
  } catch (err) {
    console.log(err);
  }
};
