import MenuItem from "../models/menuItem.model.js";
import Order from "../models/orders.model.js";
import {
  calculateTotal,
  populateMenuItem,
  updatedOrder,
} from "../utils/index.js";

export const createOrderAction = async (payload, broadcast, user, tableNum) => {
  try {
    const { menuItems } = payload;
    const totalPrice = await calculateTotal(menuItems, MenuItem);
    const order = new Order({
      menuItems,
      quantity: menuItems.quantity,
      totalPrice,
    });
    await order.save();
    await order.populate("menuItems.product");
    user.state = order;
    broadcast(tableNum);
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
    broadcast(tableNum);
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
    user.state = {
      orderStatus: orderUpdate.orderStatus,
    };
    broadcast(tableNum);
  } catch (err) {
    console.log(err);
  }
};
