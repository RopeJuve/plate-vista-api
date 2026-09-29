import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// Applied to login and registration endpoints to slow down credential
// stuffing / brute-force and registration-spam attempts.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts, please try again later" },
});

// Guards join-code guessing on POST /auth/table/:qrCode. Only failed scans
// count, and the key includes the table, so a full restaurant sharing one
// Wi-Fi IP is not throttled by normal scanning.
export const tableJoinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.params.qrCode}`,
  message: {
    code: "RATE_LIMITED",
    message: "Too many wrong join codes, please ask staff for help",
  },
});
