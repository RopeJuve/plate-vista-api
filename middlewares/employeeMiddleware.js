import Employee from "../models/employee.modal.js";

export const checkEmployee = async (req, res, next) => {
  const { id } = req.params;
  try {
    const employee = await Employee.findById(id);
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
  try {
    const { employee } = req.body;
    const employeeName = await Employee.findOne({
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
