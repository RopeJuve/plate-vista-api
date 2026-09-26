import currency from "currency.js";
import MenuItem from "./menuItem.model.js";
import Restaurant from "../restaurants/restaurant.model.js";
import { AppError, isDuplicateKey } from "../../shared/errors.js";
import { publish } from "../../realtime/events.js";

const toCents = (price) => currency(price).intValue;

export const serializeMenuItem = (item) => {
  const source = item?.toObject ? item.toObject() : item;
  return {
    _id: String(source._id),
    title: source.title,
    priceCents: source.priceCents,
    inStock: Boolean(source.inStock),
    category: source.category,
    archived: Boolean(source.archived),
  };
};

const visible = { archived: false };

const toPublicMenu = (item) => {
  const source = item?.toObject ? item.toObject() : item;
  return {
    _id: String(source._id),
    title: source.title,
    description: source.description,
    price: currency(source.priceCents ?? 0, { fromCents: true }).value,
    priceCents: source.priceCents,
    image: source.image,
    category: source.category,
    inStock: Boolean(source.inStock),
    station: source.station || "kitchen",
    popular: Boolean(source.popular),
  };
};

const toDTO = (item) => {
  const source = item.toObject ? item.toObject() : item;
  return {
    ...source,
    priceCents: source.priceCents,
    price: currency(source.priceCents ?? 0, { fromCents: true }).value,
  };
};

export const listMenuItems = async (restaurantId, category) => {
  const filter = { restaurantId, ...visible };
  if (category !== undefined) filter.category = category;
  const items = await MenuItem.find(filter).lean();
  return items.map((item) => toDTO(item));
};

export const listCategories = async (restaurantId) => {
  const items = await MenuItem.find({ restaurantId, ...visible }).select("category").lean();
  return [...new Set(items.map((item) => item.category))];
};

export const getMenuItem = async (restaurantId, id) => {
  const item = await MenuItem.findOne({ _id: id, restaurantId, ...visible });
  if (!item) throw new AppError("NOT_FOUND", "Not found", 404);
  return toDTO(item);
};

export const createMenuItem = async (restaurantId, input) => {
  try {
    const item = await MenuItem.create({
      restaurantId,
      title: input.title,
      description: input.description,
      price: currency(input.price).value,
      priceCents: toCents(input.price),
      image: input.image,
      category: input.category,
      station: input.station || "kitchen",
      popular: input.popular ?? false,
      inStock: input.inStock ?? true,
    });
    publishMenu(restaurantId, serializeMenuItem(item));
    return toDTO(item);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError("VALIDATION", "Item already exists", 409);
    }
    throw error;
  }
};

const publishMenu = (restaurantId, data) => {
  publish({
    restaurantId,
    fanout: true,
    message: { type: "event", event: "menu.updated", data },
  });
};

export const updateMenuItem = async (restaurantId, id, input) => {
  const patch = { ...input };
  if (patch.price != null) {
    patch.price = currency(patch.price).value;
    patch.priceCents = toCents(patch.price);
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return getMenuItem(restaurantId, id);

  const item = await MenuItem.findOneAndUpdate(
    { _id: id, restaurantId, ...visible },
    patch,
    { new: true, runValidators: true }
  );
  if (!item) throw new AppError("NOT_FOUND", "Not found", 404);
  publishMenu(restaurantId, serializeMenuItem(item));
  return toDTO(item);
};

export const archiveMenuItem = async (restaurantId, id) => {
  const item = await MenuItem.findOneAndUpdate(
    { _id: id, restaurantId, ...visible },
    { archived: true, inStock: false },
    { new: true }
  );
  if (!item) throw new AppError("NOT_FOUND", "Not found", 404);
  publishMenu(restaurantId, serializeMenuItem(item));
  return item;
};

export const listBySlug = async (slug, category) => {
  const restaurant = await Restaurant.findOne({
    slug: String(slug).toLowerCase(),
    status: "active",
  });
  if (!restaurant) throw new AppError("NOT_FOUND", "Not found", 404);
  const items = await listMenuItems(restaurant._id, category);
  return items.map((item) => toPublicMenu(item));
};

export const getBySlug = async (slug, id) => {
  const restaurant = await Restaurant.findOne({
    slug: String(slug).toLowerCase(),
    status: "active",
  });
  if (!restaurant) throw new AppError("NOT_FOUND", "Not found", 404);
  return toPublicMenu(await getMenuItem(restaurant._id, id));
};
