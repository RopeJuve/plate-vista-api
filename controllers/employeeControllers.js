import Employee from "../models/employee.modal.js";
import { hashPassword, pick } from "../utils/index.js";
import { sanitizedUser, sanitizedUsers } from "../utils/index.js";

export const getEmployees = async (req, res, next) => {
  try {
    const employees = await Employee.find().lean();
    res.status(200).json(sanitizedUsers(employees));
  } catch (error) {
    next(error);
  }
};

export const getEmployeeById = async (req, res) => {
  res.status(200).json(sanitizedUser(req.employee));
};

export const createEmployee = async (req, res, next) => {
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
    next(error);
  }
};

export const updateEmployee = async (req, res, next) => {
  try {
    const updateBody = pick(req.body, [
      "employee",
      "email",
      "password",
      "position",
    ]);
    if (updateBody.password) {
      updateBody.password = await hashPassword(updateBody.password);
    }
    const employee = await Employee.findByIdAndUpdate(
      req.params.id,
      updateBody,
      { new: true, runValidators: true }
    );
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }
    res.status(200).json(sanitizedUser(employee));
  } catch (error) {
    next(error);
  }
};

export const deleteEmployee = async (req, res, next) => {
  try {
    await Employee.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Employee deleted successfully" });
  } catch (error) {
    next(error);
  }
};
