import { generateToken, verifyToken } from "../utils/index.js";

export const jwtSingToken = (req, res, next) => {
  const { user } = req;

  if (!user) return res.status(401).json({ message: "Unauthorized" });

  try {
    const token = generateToken(user);
    res.setHeader("Authorization", `Bearer ${token}`);
    req.token = token;
    next();
  } catch (error) {
    console.log(error);
  }
};

export const jwtVerifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const user = verifyToken(token);
    req.token = token;
    req.user = user;
    next();
  } catch (error) {
    console.log(error);
    return res.status(403).json({ message: "Forbidden" });
  }
};
