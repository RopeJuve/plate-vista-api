import currency from "currency.js";
import MenuItem from "../menu/menuItem.model.js";
import Category from "../categories/category.model.js";
import { AppError } from "../../shared/errors.js";
import { MAX_QUANTITY } from "./order.schemas.js";

export const mergeItems = (items) => {
  const merged = new Map();
  items.forEach((item) => {
    const key = String(item.productId);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...item, quantity: item.quantity });
      return;
    }
    existing.quantity += item.quantity;
  });
  return [...merged.values()];
};

export const priceItems = async (restaurantId, items, mongoSession) => {
  const merged = mergeItems(items);
  const tooLarge = merged.find((item) => item.quantity > MAX_QUANTITY);
  if (tooLarge) {
    throw new AppError("VALIDATION", "must be <= 99", 400, {
      fields: { quantity: "must be <= 99" },
    });
  }

  const ids = merged.map((item) => item.productId);
  const products = await MenuItem.find({
    _id: { $in: ids },
    restaurantId,
    archived: false,
  }).session(mongoSession);

  const byId = new Map(products.map((product) => [String(product._id), product]));
  const missing = merged.filter((item) => !byId.has(String(item.productId)));
  if (missing.length > 0) {
    throw new AppError("NOT_FOUND", "Not found", 404);
  }
  const outOfStock = merged.filter((item) => byId.get(String(item.productId)).inStock === false);
  if (outOfStock.length > 0) {
    throw new AppError("OUT_OF_STOCK", "Out of stock", undefined, {
      productIds: outOfStock.map((item) => String(item.productId)),
    });
  }
  // Each line keeps the station and category name it was ordered with, so a
  // later change to the category never moves an open ticket.
  const categories = await Category.find({
    _id: { $in: products.map((product) => product.categoryId) },
    restaurantId,
  }).session(mongoSession);
  const categoryOf = new Map(categories.map((category) => [String(category._id), category]));

  let total = currency(0);
  const priced = merged.map((item) => {
    const product = byId.get(String(item.productId));
    const unit = currency(product.priceCents, { fromCents: true });
    const line = unit.multiply(item.quantity);
    total = total.add(line);
    return {
      productId: product._id,
      title: product.title,
      unitPriceCents: unit.intValue,
      quantity: item.quantity,
      lineTotalCents: line.intValue,
      notes: item.notes || "",
      status: "pending",
      station: categoryOf.get(String(product.categoryId))?.station || "kitchen",
      category: categoryOf.get(String(product.categoryId))?.name,
    };
  });

  return { items: priced, totalCents: total.intValue };
};
