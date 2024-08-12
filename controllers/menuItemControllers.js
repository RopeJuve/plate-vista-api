import MenuItem from "../models/menuItem.model.js";

export const getMenuItems = async (req, res) => {
  try {
    const menuItems = await MenuItem.find();
    return res.status(200).json(menuItems);
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
  try {
    const { id } = req.params;
    const menuItem = await MenuItem.findById(id);
    return res.status(200).json(menuItem);
  } catch (error) {
    return res.status(500).send(error.message);
  }
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
