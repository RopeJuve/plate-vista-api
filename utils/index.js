import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import currency from "currency.js";
import mongoose from "mongoose";
dotenv.config();

export const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
};

export const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

export const generateToken = (user) => {
  const isEmployee = Boolean(user.position);
  const payload = isEmployee
    ? { id: user._id, role: "employee", position: user.position }
    : { id: user._id, role: "user" };
  return jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "1h",
  });
};

export const verifyToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
};

// Short-lived token that scopes a WebSocket connection to a single table,
// for guests (and optionally an identified logged-in user) ordering at
// that table. Never trust a client-supplied tableNum outside this token.
export const generateTableToken = (tableNum, user) => {
  const payload = user
    ? { role: "guest", tableNum: String(tableNum), userId: user._id }
    : { role: "guest", tableNum: String(tableNum) };
  return jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "4h",
  });
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

export const pick = (source, allowedKeys) => {
  const result = {};
  allowedKeys.forEach((key) => {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = source[key];
    }
  });
  return result;
};

const MAX_MENU_ITEMS = 50;
const MAX_QUANTITY = 100;

// Mirrors validators/orderValidators.js's checkBody so WebSocket payloads
// (which never go through express-validator) get the same bounds as REST.
export const assertValidMenuItems = (menuItems) => {
  if (
    !Array.isArray(menuItems) ||
    menuItems.length === 0 ||
    menuItems.length > MAX_MENU_ITEMS
  ) {
    throw new OrderError(
      `menuItems must be a non-empty array of at most ${MAX_MENU_ITEMS} items`,
      400
    );
  }
  menuItems.forEach((item) => {
    if (!item || !mongoose.Types.ObjectId.isValid(item.product)) {
      throw new OrderError("product must be a valid MongoId", 400);
    }
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0 ||
      item.quantity >= MAX_QUANTITY
    ) {
      throw new OrderError(
        `quantity must be a positive integer less than ${MAX_QUANTITY}`,
        400
      );
    }
  });
};

export class OrderError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "OrderError";
    this.status = status;
  }
}

// Pure: reads menu item prices/stock and returns a total. Never mutates
// the database - callers apply numSold increments separately, after the
// order itself has been saved successfully.
export const calculateTotal = async (items, model) => {
  let total = currency(0);
  const menuItems = await Promise.all(
    items.map((item) => model.findById(item.product))
  );
  menuItems.forEach((menuItem, index) => {
    const item = items[index];
    if (!menuItem) {
      throw new OrderError(`MenuItem not found: ${item.product}`, 404);
    }
    if (menuItem.inStock === false) {
      throw new OrderError(`MenuItem out of stock: ${menuItem.title}`, 409);
    }
    const itemPrice = currency(menuItem.price);
    const itemQuantity = currency(item.quantity);
    total = total.add(itemPrice.multiply(itemQuantity));
  });
  return total.value;
};

// Applies each item's quantity to numSold as an atomic increment, so
// concurrent orders can't lose updates the way find -> mutate -> save did.
export const incrementSoldCounts = async (items, model) => {
  await Promise.all(
    items.map((item) =>
      model.updateOne(
        { _id: item.product },
        { $inc: { numSold: item.quantity } }
      )
    )
  );
};

export const updatedOrder = async (order, reqBody, MenuItem) => {
  const newItems = reqBody.menuItems;
  if (!Array.isArray(newItems) || newItems.length === 0) {
    throw new OrderError("menuItems is required", 400);
  }

  const quantities = new Map();
  order.menuItems.forEach((item) => {
    const productId = (item.product._id || item.product).toString();
    quantities.set(productId, (quantities.get(productId) || 0) + item.quantity);
  });
  newItems.forEach((item) => {
    quantities.set(item.product, (quantities.get(item.product) || 0) + item.quantity);
  });
  const mergedItems = Array.from(quantities, ([product, quantity]) => ({
    product,
    quantity,
  }));

  const totalPrice = await calculateTotal(mergedItems, MenuItem);
  order.menuItems = mergedItems;
  order.totalPrice = totalPrice;
  await order.save();
  await incrementSoldCounts(newItems, MenuItem);
  return order;
};
