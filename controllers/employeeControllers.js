import { hashPassword } from "../utils/index.js";
import { sanitizedUser, sanitizedUsers } from "../utils/index.js";

export const getEmployees = async (req, res) => {
  try {
    const { dbConnection } = req;
    const employees = await dbConnection.model("Employee").find();
    res.status(200).json(sanitizedUsers(employees));
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

export const getEmployeeById = async (req, res) => {
  try {
    res.status(200).json(sanitizedUser(req.employee));
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

export const createEmployee = async (req, res) => {
  const { employee, email, password, position } = req.body;
  try {
    const hashedPassword = await hashPassword(password);
    const { dbConnection } = req;
    const newEmployee = await dbConnection.model("Employee").create({
      employee,
      email,
      password: hashedPassword,
      position,
    });
    res.status(201).json(sanitizedUser(newEmployee));
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

export const updateEmployee = async (req, res) => {
  try {
    const { dbConnection } = req;
    const employee = await dbConnection
      .model("Employee")
      .findByIdAndUpdate(req.params.id, req.body, {
        new: true,
      });
    res.status(200).json(sanitizedUser(employee));
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

export const deleteEmployee = async (req, res) => {
  try {
    const { dbConnection } = req;
    await dbConnection.model("Employee").findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Employee deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};
