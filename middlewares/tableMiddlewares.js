import Table from "../models/table.model.js";

export const checkTable = async (req, res, next) => {
  const { id } = req.params;

  try {
    const table = await Table.findById(id);
    if (!table) {
      return res.status(404).json({ message: "Table not found" });
    }
    req.table = table;
    next();
  } catch (error) {
    res.status(500).json("Internal server error");
  }
};

export const checkBeforeCreateTable = async (req, res, next) => {
  const { tableNumber } = req.body;

  try {
    const table = await Table.findOne({ tableNumber });
    if (table) {
      return res.status(409).json({ message: "Table number already exists" });
    }
    next();
  } catch (error) {
    res.status(500).json("Internal server error");
  }
};
