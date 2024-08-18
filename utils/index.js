import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import currency from "currency.js";
dotenv.config();

export const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
};

export const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

export const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      username: user.username,
      email: user.email,
    },
    process.env.SECRET,
    { expiresIn: "1h" }
  );
};

export const verifyToken = (token) => {
  return jwt.verify(token, process.env.SECRET);
};
export const sanitizedUsers = (users) => {
  return users.map((user) => {
    const { password, __v, ...rest } = user._doc;
    return rest;
  });
};

export const sanitizedUser = (user) => {
  const { password, __v, ...rest } = user._doc;
  return rest;
};

export const calculateTotal = async (items, model) => {
  let total = currency(0);
  await Promise.all(
    items.map(async (item) => {
      const menuItem = await model.findById(item.product);
      if (!menuItem) {
        throw currency(0);
      }
      menuItem.numSold = currency(menuItem.numSold).add(item.quantity);
      await menuItem.save();
      const itemPrice = currency(menuItem.price);
      const itemQuantity = currency(item.quantity);
      const itemTotal = itemPrice.multiply(itemQuantity);
      total = total.add(itemTotal);
    })
  );
  return total.value;
};

export const populateMenuItem = async (items, MenuItem) => {
  return await Promise.all(
    items.map(async (item) => {
      const menuItem = await MenuItem.findById(item.product);
      return { product: menuItem, quantity: item.quantity };
    })
  );
};

export const updatedOrder = async (order, reqBody, MenuItem) => {
  const newTotalPrice = await calculateTotal(reqBody.menuItems, MenuItem);
  if (newTotalPrice === 0) {
    return res.status(404).json({ message: "MenuItem not found" });
  }
  order.totalPrice = currency(order.totalPrice).add(newTotalPrice).value;
  const existingMenuItems = order.menuItems.filter((item) => {
    return item.product._id.toString() === reqBody.menuItems[0].product;
  }).length;
  if (existingMenuItems === 0) {
    order.menuItems = [...order.menuItems, ...reqBody.menuItems];
  } else {
    const foundItem = order.menuItems.find(
      (item) => item.product._id.toString() === reqBody.menuItems[0].product
    );
    foundItem.quantity += reqBody.menuItems[0].quantity;
  }
  await order.save();
  return order;
};
