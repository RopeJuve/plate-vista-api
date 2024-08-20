import MenuItem from "../models/menuItem.model.js";

export const getMenuItems = async (req, res) => {
  try {
    const { category } = req.query;
    if (category) {
      const menuItems = await MenuItem.find({ category });
      return res.status(200).json(menuItems);
    }
    const menuItems = await MenuItem.find();
    return res.status(200).json(menuItems);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

export const getAllCategory = async (req, res) => {
  try {
    const categories = await MenuItem.distinct("category");
    return res.status(200).json(categories);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

export const createMenuItem = async (req, res) => {
  try {
    const menuItem = await MenuItem.create(req.body);
    return res.status(201).json(menuItem);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

export const getMenuItem = async (req, res) => {
  return res.status(200).json(req.item);
};

export const updateMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    const menuItem = await MenuItem.findByIdAndUpdate(id, req.body, {
      new: true,
    });
    return res.status(200).json(menuItem);
  } catch (error) {
    return res.status(500).send(error.message);
  }
};

export const deleteMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    await MenuItem.findByIdAndDelete(id);
    return res.status(200).json({ message: "MenuItem deleted successfully" });
  } catch (error) {
    return res.status(500).send(error.message);
  }
};
