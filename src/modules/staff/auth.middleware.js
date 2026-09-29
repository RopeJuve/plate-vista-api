import mongoose from "mongoose";
import { verifyToken } from "../../shared/auth.js";

export const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: "Unauthorized" });
  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Unauthorized" });
  try {
    const payload = verifyToken(token);
    req.token = token;
    req.user = payload;
    req.auth = payload;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Unauthorized" });
  }
};

export const requireTenant = (req, res, next) => {
  const restaurantId = req.auth?.restaurantId || req.user?.restaurantId;
  if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  req.tenant = { restaurantId: String(restaurantId) };
  next();
};

export const requireRole = (...allowed) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  const { role, position } = req.user;
  const identities = new Set([role, position].filter(Boolean));
  if (role === "employee") identities.add("employee");
  if (
    position === "owner" ||
    role === "owner" ||
    position === "admin" ||
    role === "admin"
  ) {
    identities.add("admin");
    identities.add("employee");
  }
  const hasAccess = allowed.some((entry) => identities.has(entry));
  if (!hasAccess) return res.status(403).json({ message: "Forbidden" });
  next();
};

// Customer accounts are global, not owned by a restaurant, so a restaurant
// admin has no authority over them. Anyone can register a restaurant.
export const requireSelf = (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  const isSelf = req.user.role === "user" && req.user.id === req.params.id;
  if (!isSelf) return res.status(403).json({ message: "Forbidden" });
  next();
};

export const checkId = (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ message: "Not found" });
  }
  next();
};
