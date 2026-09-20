import Table from "../models/table.model.js";
import { pick } from "../utils/index.js";

const TABLE_FIELDS = ["tableNumber", "capacity", "status"];

export const getTables = async (req, res, next) => {
  try {
    const tables = await Table.find().lean();
    res.status(200).json(tables);
  } catch (error) {
    next(error);
  }
};

export const createTable = async (req, res, next) => {
  const table = pick(req.body, TABLE_FIELDS);
  try {
    const newTable = new Table(table);
    await newTable.save();
    res.status(201).json(newTable);
  } catch (error) {
    next(error);
  }
};

export const getTableById = async (req, res) => {
  res.status(200).json(req.table);
};

export const updateTable = async (req, res, next) => {
  const { id } = req.params;
  try {
    const updatedTable = await Table.findByIdAndUpdate(
      id,
      pick(req.body, TABLE_FIELDS),
      { new: true, runValidators: true }
    );
    res.status(200).json(updatedTable);
  } catch (error) {
    next(error);
  }
};

export const deleteTable = async (req, res, next) => {
  const { id } = req.params;
  try {
    const deletedTable = await Table.findByIdAndDelete(id);
    if (!deletedTable) {
      return res.status(404).json({ message: "Table not found" });
    }
    res.json({ message: "Table deleted successfully." });
  } catch (error) {
    next(error);
  }
};
