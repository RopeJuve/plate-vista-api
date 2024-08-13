import MenuItem from "../models/menuItem.model.js";

export const checkItem = async (req, res, next) => {
  const { id } = req.params;
  try {
    const item = await MenuItem.findById(id);
    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }
    req.item = item;
    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const checkBeforeCreate = async (req, res, next) => {
  try {
    const { title } = req.body;
    const item = await MenuItem.findOne({
      title,
    });
    if (item) {
      return res.status(409).json({ message: "Item already exists" });
    }
    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
