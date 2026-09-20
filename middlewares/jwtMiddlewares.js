import { generateToken, verifyToken } from "../utils/index.js";

export const jwtSingToken = (req, res, next) => {
  const { user } = req;

  if (!user) return res.status(401).json({ message: "Unauthorized" });

  try {
    const token = generateToken(user);
    res.setHeader("Authorization", `Bearer ${token}`);
    req.user = user;
    next();
  } catch (error) {
    return res.status(500).json({ message: "Internal server error " });
  }
};

// Returns 401 for any authentication failure (missing/expired/invalid token).
// Role/permission failures are handled separately by requireRole (403).
export const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const payload = verifyToken(token);
    req.token = token;
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Unauthorized" });
  }
};

// Backwards-compatible alias.
export const jwtVerifyToken = requireAuth;

// allowed may contain "user", "employee" (any position) or a specific
// employee position such as "admin", "waiter", "kitchen".
export const requireRole = (...allowed) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const { role, position } = req.user;
  const identities = [role, position].filter(Boolean);
  const hasAccess = identities.some((identity) => allowed.includes(identity));
  if (!hasAccess) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};

// For /users/:id — an admin employee, or the user themself.
export const requireSelfOrAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const isAdmin = req.user.role === "employee" && req.user.position === "admin";
  const isSelf = req.user.role === "user" && req.user.id === req.params.id;
  if (!isAdmin && !isSelf) {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
};
