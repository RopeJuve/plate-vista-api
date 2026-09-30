import mongoose from "mongoose";
import { z } from "zod";
import Category, { CATEGORY_NAME_COLLATION, STATIONS } from "./category.model.js";
import MenuItem from "../menu/menuItem.model.js";
import { DEFAULT_CATEGORIES } from "./defaultCategories.js";
import { AppError, isDuplicateKey } from "../../shared/errors.js";
import { parseOrThrow } from "../../shared/validate.js";

const name = z
  .string({ error: "Name is required" })
  .trim()
  .min(1, "Name is required")
  .max(40, "Name must be at most 40 characters");
const station = z.enum(STATIONS, { error: "Station must be kitchen or bar" });

const createSchema = z.object({ name, station });
const updateSchema = z.object({ name, station }).partial();
const moveSchema = z.object({ direction: z.enum(["up", "down"], { error: "Direction must be up or down" }) });

export const serializeCategory = (category) => ({
  _id: String(category._id),
  name: category.name,
  station: category.station,
  position: category.position,
});

const duplicateName = () =>
  new AppError("VALIDATION", "A category with this name already exists", 409, {
    fields: { name: "A category with this name already exists" },
  });

const inMenuOrder = (restaurantId) =>
  Category.find({ restaurantId }).sort({ position: 1, _id: 1 }).lean();

export const listCategories = async (restaurantId) =>
  (await inMenuOrder(restaurantId)).map(serializeCategory);

// Every category of the restaurant by id, for resolving menu items.
export const categoriesById = async (restaurantId) =>
  new Map((await inMenuOrder(restaurantId)).map((category) => [String(category._id), category]));

export const findCategory = async (restaurantId, categoryId) => {
  if (!mongoose.Types.ObjectId.isValid(String(categoryId))) return null;
  return Category.findOne({ _id: categoryId, restaurantId }).lean();
};

const nextPosition = async (restaurantId) => {
  const last = await Category.findOne({ restaurantId }).sort({ position: -1 }).lean();
  return (last?.position ?? 0) + 1;
};

export const createCategory = async (restaurantId, input) => {
  const data = parseOrThrow(createSchema, input || {});
  try {
    const category = await Category.create({
      restaurantId,
      ...data,
      position: await nextPosition(restaurantId),
    });
    return serializeCategory(category);
  } catch (error) {
    if (isDuplicateKey(error)) throw duplicateName();
    throw error;
  }
};

const notFound = () => new AppError("NOT_FOUND", "Not found", 404);

export const updateCategory = async (restaurantId, id, input) => {
  const data = parseOrThrow(updateSchema, input || {});
  try {
    const category = await Category.findOneAndUpdate({ _id: id, restaurantId }, data, {
      new: true,
      runValidators: true,
    });
    if (!category) throw notFound();
    return serializeCategory(category);
  } catch (error) {
    if (isDuplicateKey(error)) throw duplicateName();
    throw error;
  }
};

// Swaps the category with its neighbour; at either end it stays put.
export const moveCategory = async (restaurantId, id, input) => {
  const { direction } = parseOrThrow(moveSchema, input || {});
  const ordered = await inMenuOrder(restaurantId);
  const index = ordered.findIndex((category) => String(category._id) === String(id));
  if (index === -1) throw notFound();
  const neighbour = ordered[direction === "up" ? index - 1 : index + 1];
  if (neighbour) {
    // Rewrite every position so ties from older data are resolved too.
    const reordered = [...ordered];
    reordered[index] = neighbour;
    reordered[direction === "up" ? index - 1 : index + 1] = ordered[index];
    await Category.bulkWrite(
      reordered.map((category, position) => ({
        updateOne: {
          filter: { _id: category._id, restaurantId },
          update: { $set: { position: position + 1 } },
        },
      }))
    );
  }
  return listCategories(restaurantId);
};

// A category with items is never deleted: nothing moves or disappears as a
// side effect. Archived items no longer count.
export const deleteCategory = async (restaurantId, id) => {
  const category = await Category.findOne({ _id: id, restaurantId });
  if (!category) throw notFound();
  const items = await MenuItem.countDocuments({ restaurantId, categoryId: category._id, archived: false });
  if (items > 0) {
    throw new AppError(
      "VALIDATION",
      `Move its ${items} ${items === 1 ? "item" : "items"} to another category first`,
      409
    );
  }
  await Category.deleteOne({ _id: category._id, restaurantId });
};

// Adds whichever default categories the restaurant lacks (matching names
// ignoring case) after its existing ones. Safe to run again.
export const ensureDefaultCategories = async (restaurantId) => {
  const existing = await Category.find({ restaurantId })
    .collation(CATEGORY_NAME_COLLATION)
    .select("name")
    .lean();
  const taken = new Set(existing.map((category) => category.name.toLowerCase()));
  const missing = DEFAULT_CATEGORIES.filter((category) => !taken.has(category.name.toLowerCase()));
  if (missing.length === 0) return 0;
  let position = await nextPosition(restaurantId);
  await Category.insertMany(
    missing.map((category) => ({ restaurantId, ...category, position: position++ }))
  );
  return missing.length;
};
