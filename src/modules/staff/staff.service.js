import { z } from "zod";
import Restaurant from "../restaurants/restaurant.model.js";
import Employee from "./employee.model.js";
import User from "./user.model.js";
import {
  hashPassword,
  parsePagination,
  sanitizedUser,
  sanitizedUsers,
  generateToken,
  generateTableToken,
  verifyToken,
} from "../../shared/auth.js";
import { AppError, isDuplicateKey } from "../../shared/errors.js";
import { anonymizeUser } from "../ordering/order.service.js";
import { findByQrCode } from "../tables/table.service.js";
import { openOrJoinSessionSafe } from "../ordering/session.service.js";

const registerSchema = z.object({
  restaurantName: z.string().trim().min(2),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase letters, numbers, and dashes"),
  employee: z.string().trim().min(4),
  email: z.string().email(),
  password: z.string().min(8),
});

const userSchema = z.object({
  username: z.string().min(4, "Username must be at least 4 characters long"),
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters long"),
});

const userUpdateSchema = userSchema.partial();

const employeeSchema = z.object({
  employee: z.string().min(4, "Employee name must be at least 4 characters long"),
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters long"),
  position: z.string().min(3, "Position must be at least 3 characters long"),
});

const employeeUpdateSchema = employeeSchema.partial();

const roleFromPosition = (position) => {
  const value = String(position || "").toLowerCase();
  if (["owner", "admin", "waiter", "kitchen", "staff"].includes(value)) return value;
  return "staff";
};

export const registerRestaurant = async (input) => {
  const data = registerSchema.parse(input);
  try {
    const restaurant = await Restaurant.create({
      name: data.restaurantName,
      slug: data.slug,
      status: "active",
      settings: { currency: "EUR", timezone: "Europe/Berlin" },
    });
    const employee = await Employee.create({
      restaurantId: restaurant._id,
      employee: data.employee,
      email: data.email.toLowerCase(),
      password: await hashPassword(data.password),
      position: "owner",
      role: "owner",
    });
    return { restaurant, employee, token: generateToken(employee) };
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError("VALIDATION", "Account already exists", 409);
    }
    if (error instanceof z.ZodError) {
      throw new AppError("VALIDATION", error.issues[0]?.message || "Invalid request");
    }
    throw error;
  }
};

export const issueTableToken = async (qrCode, authHeader) => {
  const table = await findByQrCode(qrCode);
  const session = await openOrJoinSessionSafe(table.restaurantId, table._id);
  let user;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const decoded = verifyToken(authHeader.split(" ")[1]);
      if (decoded.role === "user") user = { _id: decoded.id };
    } catch (error) {
      user = undefined;
    }
  }
  const token = generateTableToken({
    restaurantId: table.restaurantId,
    tableId: table._id,
    sessionId: session._id,
    user,
  });
  return {
    token,
    sessionId: session._id,
    table: { id: table._id, tableNumber: table.tableNumber },
  };
};

export const createUser = async (input) => {
  const data = userSchema.parse(input);
  const existing = await User.findOne({ $or: [{ username: data.username }, { email: data.email }] });
  if (existing) throw new AppError("VALIDATION", "User already exists", 409);
  const user = await User.create({
    username: data.username,
    email: data.email,
    password: await hashPassword(data.password),
  });
  return sanitizedUser(user);
};

export const listUsers = async (query) => {
  const { page, limit, skip } = parsePagination(query);
  const [users, total] = await Promise.all([
    User.find().skip(skip).limit(limit).lean(),
    User.countDocuments(),
  ]);
  return { users: sanitizedUsers(users), page, limit, total };
};

export const getUser = async (id) => {
  const user = await User.findById(id);
  if (!user) throw new AppError("NOT_FOUND", "User not found", 404);
  return sanitizedUser(user);
};

export const updateUser = async (id, input) => {
  const data = userUpdateSchema.parse(input);
  if (data.password) data.password = await hashPassword(data.password);
  const user = await User.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  if (!user) throw new AppError("NOT_FOUND", "User not found", 404);
  return sanitizedUser(user);
};

export const deleteUser = async (id) => {
  const user = await User.findByIdAndDelete(id);
  if (!user) throw new AppError("NOT_FOUND", "User not found", 404);
  await anonymizeUser(id);
};

export const listEmployees = async (restaurantId) => {
  const employees = await Employee.find({ restaurantId }).lean();
  return sanitizedUsers(employees);
};

export const getEmployee = async (restaurantId, id) => {
  const employee = await Employee.findOne({ _id: id, restaurantId });
  if (!employee) throw new AppError("NOT_FOUND", "Not found", 404);
  return sanitizedUser(employee);
};

export const createEmployee = async (restaurantId, input) => {
  const data = employeeSchema.parse(input);
  try {
    const employee = await Employee.create({
      restaurantId,
      employee: data.employee,
      email: data.email.toLowerCase(),
      password: await hashPassword(data.password),
      position: data.position,
      role: roleFromPosition(data.position),
    });
    return sanitizedUser(employee);
  } catch (error) {
    if (isDuplicateKey(error)) throw new AppError("VALIDATION", "Employee already exists", 409);
    throw error;
  }
};

export const updateEmployee = async (restaurantId, id, input) => {
  const data = employeeUpdateSchema.parse(input);
  if (data.password) data.password = await hashPassword(data.password);
  if (data.position) data.role = roleFromPosition(data.position);
  const employee = await Employee.findOneAndUpdate(
    { _id: id, restaurantId },
    data,
    { new: true, runValidators: true }
  );
  if (!employee) throw new AppError("NOT_FOUND", "Not found", 404);
  return sanitizedUser(employee);
};

export const deleteEmployee = async (restaurantId, id) => {
  const employee = await Employee.findOneAndDelete({ _id: id, restaurantId });
  if (!employee) throw new AppError("NOT_FOUND", "Not found", 404);
};
