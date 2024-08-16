import Employee from "../models/employee.modal.js";
import { hashPassword } from "../utils/index.js";
import { sanitizedUser, sanitizedUsers } from "../utils/index.js";

export const getEmployees = async (req, res) => {
  try {
    const employees = await Employee.find();
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
    const newEmployee = new Employee({
      employee,
      email,
      password: hashedPassword,
      position,
    });
    await newEmployee.save();
    res.status(201).json(sanitizedUser(newEmployee));
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

export const updateEmployee = async (req, res) => {
  try {
    const employee = await Employee.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    res.status(200).json(sanitizedUser(employee));
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

export const deleteEmployee = async (req, res) => {
  try {
    await Employee.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Employee deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};
