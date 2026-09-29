import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

export const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

export const comparePassword = async (password, hashedPassword) =>
  bcrypt.compare(password, hashedPassword);

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export const generateToken = (user) => {
  const isEmployee = Boolean(user.position) || user.role === "owner";
  const payload = isEmployee
    ? { id: user._id, role: "employee", position: user.position || user.role }
    : { id: user._id, role: "user" };
  if (user.restaurantId) {
    payload.restaurantId = String(user.restaurantId);
  }
  return jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
};

export const verifyToken = (token) =>
  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });

export const generateWsTicket = (claims) => {
  const { iat, exp, nbf, purpose, ...rest } = claims || {};
  return jwt.sign({ ...rest, purpose: "ws" }, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: 60,
  });
};

// Guest tokens are bound to a table session. Closing that session makes
// the token unusable even if it has not expired yet.
export const generateTableToken = ({ restaurantId, tableId, sessionId, user }) => {
  const payload = {
    role: "guest",
    restaurantId: String(restaurantId),
    tableId: String(tableId),
    sessionId: String(sessionId),
  };
  if (user?._id) payload.userId = String(user._id);
  return jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "4h",
  });
};

export const sanitizedUser = (user) => {
  const { password, __v, ...rest } = user._doc || user;
  return rest;
};

export const sanitizedUsers = (users) => users.map((user) => sanitizedUser(user));

export const parsePagination = (query) => {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};
