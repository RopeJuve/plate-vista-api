import rateLimit from "express-rate-limit";

// Applied to login and registration endpoints to slow down credential
// stuffing / brute-force and registration-spam attempts.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts, please try again later" },
});
