import currency from "currency.js";
import MenuItem from "./menuItem.model.js";
import Restaurant from "../restaurants/restaurant.model.js";
import { AppError, isDuplicateKey } from "../../shared/errors.js";
import { publish } from "../../realtime/events.js";
import { categoriesById, findCategory } from "../categories/category.service.js";

const toCents = (price) => currency(price).intValue;

// Name and station come from the item's category; the station is never the
// item's own (docs/adr/0001-station-belongs-to-category.md).
const categoryFields = (source, categories) => {
  const category = categories.get(String(source.categoryId));
  return {
    categoryId: source.categoryId ? String(source.categoryId) : null,
    category: category?.name ?? null,
    station: category?.station ?? "kitchen",
  };
};

export const serializeMenuItem = (item, categories) => {
  const source = item?.toObject ? item.toObject() : item;
  return {
    _id: String(source._id),
    title: source.title,
    priceCents: source.priceCents,
    inStock: Boolean(source.inStock),
    ...categoryFields(source, categories),
    archived: Boolean(source.archived),
  };
};

const visible = { archived: false };

const toPublicMenu = (item) => ({
  _id: String(item._id),
  title: item.title,
  description: item.description || "",
  price: item.price,
  priceCents: item.priceCents,
  image: item.image || null,
  category: item.category,
  inStock: Boolean(item.inStock),
  station: item.station,
  popular: Boolean(item.popular),
});

const toDTO = (item, categories) => {
  const source = item.toObject ? item.toObject() : item;
  return {
    ...source,
    description: source.description || "",
    image: source.image || null,
    ...categoryFields(source, categories),
    priceCents: source.priceCents,
    price: currency(source.priceCents ?? 0, { fromCents: true }).value,
  };
};

// Menu order: category order, then popular items, then by name.
const inMenuOrder = (items, categories) => {
  const positionOf = (item) => categories.get(String(item.categoryId))?.position ?? Infinity;
  return [...items].sort(
    (a, b) =>
      positionOf(a) - positionOf(b) ||
      Number(Boolean(b.popular)) - Number(Boolean(a.popular)) ||
      a.title.localeCompare(b.title)
  );
};

export const listMenuItems = async (restaurantId, categoryName) => {
  const categories = await categoriesById(restaurantId);
  const filter = { restaurantId, ...visible };
  if (categoryName !== undefined) {
    const match = [...categories.values()].find((category) => category.name === categoryName);
    if (!match) return [];
    filter.categoryId = match._id;
  }
  const items = await MenuItem.find(filter).lean();
  return inMenuOrder(items, categories).map((item) => toDTO(item, categories));
};

// Names of the categories that have items, in menu order. Empty ones are not
// shown to guests.
export const listCategories = async (restaurantId) => {
  const categories = await categoriesById(restaurantId);
  const used = new Set(
    (await MenuItem.find({ restaurantId, ...visible }).select("categoryId").lean()).map((item) =>
      String(item.categoryId)
    )
  );
  return [...categories.values()]
    .filter((category) => used.has(String(category._id)))
    .map((category) => category.name);
};

export const getMenuItem = async (restaurantId, id) => {
  const item = await MenuItem.findOne({ _id: id, restaurantId, ...visible });
  if (!item) throw new AppError("NOT_FOUND", "Not found", 404);
  return toDTO(item, await categoriesById(restaurantId));
};

const assertOwnCategory = async (restaurantId, categoryId) => {
  if (!(await findCategory(restaurantId, categoryId))) {
    throw new AppError("VALIDATION", "Unknown category", 400, {
      fields: { categoryId: "Unknown category" },
    });
  }
};

export const createMenuItem = async (restaurantId, input) => {
  await assertOwnCategory(restaurantId, input.categoryId);
  try {
    const item = await MenuItem.create({
      restaurantId,
      title: input.title,
      description: input.description ?? "",
      price: currency(input.price).value,
      priceCents: toCents(input.price),
      image: input.image ?? null,
      categoryId: input.categoryId,
      popular: input.popular ?? false,
      inStock: input.inStock ?? true,
    });
    const categories = await categoriesById(restaurantId);
    publishMenu(restaurantId, serializeMenuItem(item, categories));
    return toDTO(item, categories);
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
    patch.price = currency(input.price).value;
    patch.priceCents = toCents(input.price);
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return getMenuItem(restaurantId, id);
  if (patch.categoryId !== undefined) await assertOwnCategory(restaurantId, patch.categoryId);

  const item = await MenuItem.findOneAndUpdate(
    { _id: id, restaurantId, ...visible },
    patch,
    { new: true, runValidators: true }
  );
  if (!item) throw new AppError("NOT_FOUND", "Not found", 404);
  const categories = await categoriesById(restaurantId);
  publishMenu(restaurantId, serializeMenuItem(item, categories));
  return toDTO(item, categories);
};

export const archiveMenuItem = async (restaurantId, id) => {
  const item = await MenuItem.findOneAndUpdate(
    { _id: id, restaurantId, ...visible },
    { archived: true, inStock: false },
    { new: true }
  );
  if (!item) throw new AppError("NOT_FOUND", "Not found", 404);
  publishMenu(restaurantId, serializeMenuItem(item, await categoriesById(restaurantId)));
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
