import currency from "currency.js";
import MenuItem from "../menu/menuItem.model.js";
import { AppError } from "../../shared/errors.js";

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
  const tooLarge = merged.find((item) => item.quantity >= 100);
  if (tooLarge) {
    throw new AppError("VALIDATION", "quantity must be a positive integer less than 100");
  }

  const ids = merged.map((item) => item.productId);
  const products = await MenuItem.find({
    _id: { $in: ids },
    restaurantId,
    archived: false,
  }).session(mongoSession);

  const byId = new Map(products.map((product) => [String(product._id), product]));
  let total = currency(0);
  const priced = merged.map((item) => {
    const product = byId.get(String(item.productId));
    if (!product) {
      throw new AppError("NOT_FOUND", "Not found", 404);
    }
    if (product.inStock === false) {
      throw new AppError("OUT_OF_STOCK", `${product.title} is out of stock`);
    }
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
      station: product.station || "kitchen",
    };
  });

  return { items: priced, totalCents: total.intValue };
};
