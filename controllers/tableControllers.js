import Table from "../models/table.model.js";

export const getTables = async (req, res) => {
  try {
    const tables = await Table.find();
    res.status(200).json(tables);
  } catch (error) {
    res.status(500).json("Internal server error");
  }
};

export const createTable = async (req, res) => {
  const table = req.body;
  try {
    const newTable = new Table(table);
    await newTable.save();
    res.status(201).json(newTable);
  } catch (error) {
    res.status(500).json("Internal server error");
  }
};

export const getTableById = async (req, res) => {
  try {
    res.status(200).json(req.table);
  } catch (error) {
    res.status(500).json("Internal server error");
  }
};

export const updateTable = async (req, res) => {
  const { id } = req.params;
  try {
    const updatedTable = await Table.findByIdAndUpdate(id, req.body, {
      new: true,
    });
    res.status(200).json(updatedTable);
  } catch (error) {
    res.status(500).json("Internal server error");
  }
};

export const deleteTable = async (req, res) => {
  const { id } = req.params;
  try {
    await Table.findByIdAndRemove(id);
    res.json({ message: "Table deleted successfully." });
  } catch (error) {
    res.status(500).json("Internal server error");
  }
};
