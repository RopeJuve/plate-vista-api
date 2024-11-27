export const getTables = async (req, res) => {
  try {
    const { dbConnection } = req;
    const tables = await dbConnection.model("Table").find();
    res.status(200).json(tables);
  } catch (error) {
    res.status(500).json("Internal server error");
  }
};

export const createTable = async (req, res) => {
  const table = req.body;
  try {
    const { dbConnection } = req;
    const newTable = await dbConnection.model("Table").create(table);
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
    const { dbConnection } = req;
    const updatedTable = await dbConnection
      .model("Table")
      .findByIdAndUpdate(id, req.body, {
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
    const { dbConnection } = req;
    await dbConnection.model("Table").findByIdAndRemove(id);
    res.json({ message: "Table deleted successfully." });
  } catch (error) {
    res.status(500).json("Internal server error");
  }
};

export const deleteAllTables = async (req, res) => {
  try {
    const { dbConnection } = req;
    await dbConnection.model("Table").deleteMany();
    return res.status(200).json({ message: "All Tables deleted successfully" });
  } catch (error) {
    return res.status(500).send(error.message);
  }
};
