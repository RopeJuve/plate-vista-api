import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import Restaurant from "../restaurants/restaurant.model.js";
import Employee from "./employee.model.js";
import User from "./user.model.js";
import {
  hashPassword,
  sanitizedUser,
  sanitizedUsers,
  generateTableToken,
  verifyToken,
} from "../../shared/auth.js";
import { AppError, isDuplicateKey } from "../../shared/errors.js";
import { parseOrThrow } from "../../shared/validate.js";
import { anonymizeUser } from "../ordering/order.service.js";
import { findByQrCode } from "../tables/table.service.js";
import { openOrJoinSessionWithRetry } from "../ordering/session.service.js";

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
    return { restaurant, employee };
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

const tableJoinSchema = z.object({
  joinCode: z.string().trim().max(20).optional(),
  guestToken: z.string().max(2000).optional(),
});

const decodeOrNull = (token) => {
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
};

const sameCode = (given, expected) => {
  const left = Buffer.from(given.toUpperCase());
  const right = Buffer.from(String(expected).toUpperCase());
  return left.length === right.length && timingSafeEqual(left, right);
};

// The first guest to scan a vacant table opens the session and gets its join
// code. Anyone scanning an open table must enter that code (or present their
// own earlier token for this session), so a photo of the QR code alone is not
// enough to order to someone else's table.
export const issueTableToken = async (qrCode, authHeader, input = {}) => {
  const body = parseOrThrow(tableJoinSchema, input || {});
  const table = await findByQrCode(qrCode);
  const { session, opened } = await openOrJoinSessionWithRetry(table.restaurantId, table._id);

  const previous = decodeOrNull(body.guestToken);
  const rejoining =
    previous?.role === "guest" &&
    previous.sessionId === String(session._id) &&
    previous.restaurantId === String(table.restaurantId);
  if (!opened && !rejoining) {
    if (!body.joinCode) {
      throw new AppError("JOIN_CODE_REQUIRED", "This table is already open. Enter its join code.");
    }
    if (!sameCode(body.joinCode, session.code)) {
      throw new AppError("JOIN_CODE_INVALID", "Wrong join code");
    }
  }

  const bearer = decodeOrNull(authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "");
  let user;
  if (bearer?.role === "user") user = { _id: bearer.id };
  else if (rejoining && previous.userId) user = { _id: previous.userId };

  const token = generateTableToken({
    restaurantId: table.restaurantId,
    tableId: table._id,
    sessionId: session._id,
    user,
  });
  return {
    token,
    sessionId: session._id,
    joinCode: session.code,
    opened,
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

// Access checks (requireRole) read the position, so rank does too; older
// employee documents may not have a role field at all.
const RANK = { owner: 3, admin: 2 };
const rankOf = (role) => RANK[role] || 1;
const rankOfEmployee = (employee) => rankOf(roleFromPosition(employee.position));

// The token's position can be up to an hour stale, so rules are checked
// against the actor as stored now.
const loadActor = async (restaurantId, actorId) => {
  const actor = await Employee.findOne({ _id: actorId, restaurantId });
  if (!actor) throw new AppError("FORBIDDEN", "Forbidden");
  return actor;
};

const forbid = (message) => new AppError("FORBIDDEN", message);

const assertCanGrant = (actor, role) => {
  if (rankOf(role) > rankOfEmployee(actor)) {
    throw forbid("You cannot give a role higher than your own");
  }
};

// Only employees ranked below you can be managed, so an admin cannot take over
// the owner or another admin. Your own profile is editable, not your role.
const assertCanManage = (actor, target) => {
  if (String(actor._id) === String(target._id)) return;
  if (rankOfEmployee(target) >= rankOfEmployee(actor)) {
    throw forbid("You can only manage employees ranked below you");
  }
};

export const createEmployee = async (restaurantId, actorId, input) => {
  const data = employeeSchema.parse(input);
  const actor = await loadActor(restaurantId, actorId);
  assertCanGrant(actor, roleFromPosition(data.position));
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

export const updateEmployee = async (restaurantId, actorId, id, input) => {
  const data = employeeUpdateSchema.parse(input);
  const actor = await loadActor(restaurantId, actorId);
  const target = await Employee.findOne({ _id: id, restaurantId });
  if (!target) throw new AppError("NOT_FOUND", "Not found", 404);
  assertCanManage(actor, target);
  if (data.position) {
    data.role = roleFromPosition(data.position);
    if (
      String(actor._id) === String(target._id) &&
      data.role !== roleFromPosition(target.position)
    ) {
      throw forbid("You cannot change your own role");
    }
    assertCanGrant(actor, data.role);
  }
  if (data.password) data.password = await hashPassword(data.password);
  // The position in the filter makes a concurrent promotion fail instead of
  // being overwritten by a check that ran against the old position.
  const employee = await Employee.findOneAndUpdate(
    { _id: id, restaurantId, position: target.position },
    data,
    { new: true, runValidators: true }
  );
  if (!employee) throw new AppError("NOT_FOUND", "Not found", 404);
  return sanitizedUser(employee);
};

export const deleteEmployee = async (restaurantId, actorId, id) => {
  const actor = await loadActor(restaurantId, actorId);
  const target = await Employee.findOne({ _id: id, restaurantId });
  if (!target) throw new AppError("NOT_FOUND", "Not found", 404);
  if (String(actor._id) === String(target._id)) {
    throw forbid("You cannot delete your own account");
  }
  assertCanManage(actor, target);
  const employee = await Employee.findOneAndDelete({
    _id: id,
    restaurantId,
    position: target.position,
  });
  if (!employee) throw new AppError("NOT_FOUND", "Not found", 404);
};
