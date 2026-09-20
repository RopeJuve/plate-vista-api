import MenuItem from "../models/menuItem.model.js";
import { pick } from "../utils/index.js";

const MENU_ITEM_FIELDS = [
  "title",
  "description",
  "price",
  "image",
  "category",
  "popular",
  "inStock",
];

export const getMenuItems = async (req, res, next) => {
  try {
    const { category } = req.query;
    if (category !== undefined) {
      if (typeof category !== "string") {
        return res.status(400).json({ error: "category must be a string" });
      }
      const menuItems = await MenuItem.find({ category }).lean();
      return res.status(200).json(menuItems);
    }
    const menuItems = await MenuItem.find().lean();
    return res.status(200).json(menuItems);
  } catch (error) {
    next(error);
  }
};

export const getAllCategory = async (req, res, next) => {
  try {
    const categories = await MenuItem.distinct("category");
    return res.status(200).json(categories);
  } catch (error) {
    next(error);
  }
};

export const createMenuItem = async (req, res, next) => {
  try {
    const menuItem = await MenuItem.create(pick(req.body, MENU_ITEM_FIELDS));
    return res.status(201).json(menuItem);
  } catch (error) {
    next(error);
  }
};

export const getMenuItem = async (req, res) => {
  return res.status(200).json(req.item);
};

export const updateMenuItem = async (req, res, next) => {
  try {
    const { id } = req.params;
    const menuItem = await MenuItem.findByIdAndUpdate(
      id,
      pick(req.body, MENU_ITEM_FIELDS),
      { new: true, runValidators: true }
    );
    return res.status(200).json(menuItem);
  } catch (error) {
    next(error);
  }
};

export const deleteMenuItem = async (req, res, next) => {
  try {
    const { id } = req.params;
    await MenuItem.findByIdAndDelete(id);
    return res.status(200).json({ message: "MenuItem deleted successfully" });
  } catch (error) {
    next(error);
  }
};
