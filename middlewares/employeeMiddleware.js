export const checkEmployee = async (req, res, next) => {
  const { id } = req.params;
  const { dbConnection } = req;
  try {
    const employee = await dbConnection.model("Employee").findById(id);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    req.employee = employee;
    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const checkBeforeCreate = async (req, res, next) => {
  const { dbConnection } = req;
  try {
    const { employee } = req.body;
    const employeeName = await dbConnection.model("Employee").findOne({
      employee,
    });

    if (employeeName) {
      return res.status(409).json({ message: "Employee already exists" });
    }
    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
