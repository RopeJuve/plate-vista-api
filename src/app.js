import express from "express";
import cors from "cors";
import helmet from "helmet";
import passport from "passport";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { connectToDatabase } from "./db/db.js";
import { AppError, isDuplicateKey } from "./shared/errors.js";
import { generateWsTicket } from "./shared/auth.js";
import { requireAuth } from "./modules/staff/auth.middleware.js";
import { captureException, initSentry, logger } from "./shared/logger.js";
import userPassport from "./modules/staff/userPassport.js";
import employeePassport from "./modules/staff/employeePassport.js";
import authRouter from "./modules/staff/auth.routes.js";
import userRouter from "./modules/staff/user.routes.js";
import employeeRouter from "./modules/staff/employee.routes.js";
import staffRouter from "./modules/staff/staff.routes.js";
import menuRouter, { publicMenuRouter } from "./modules/menu/menu.routes.js";
import orderRouter from "./modules/ordering/order.routes.js";
import sessionRouter from "./modules/ordering/session.routes.js";
import tableRouter from "./modules/tables/table.routes.js";
import statisticsRouter from "./modules/stats/stats.routes.js";
import internalRouter from "./modules/internal/internal.routes.js";

void initSentry();

const app = express();
const deployTarget = process.env.DEPLOY_TARGET || "local";
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Local development allows any origin. A deployed app without CORS_ORIGIN
// allows none: Vercel imports this file without running loadEnv(), so the
// env check alone would not catch a missing value there.
const corsOrigin = () => {
  if (corsOrigins.length) return corsOrigins;
  if (deployTarget === "local") return true;
  logger.error({ target: deployTarget }, "CORS_ORIGIN is not set; blocking cross-origin requests");
  return false;
};

// Vercel and Render sit behind one proxy hop. Without this every client shares
// the proxy's IP, so the rate limiters would throttle everyone together.
const trustProxy = process.env.TRUST_PROXY
  ? Number(process.env.TRUST_PROXY)
  : deployTarget === "local"
    ? 0
    : 1;
if (trustProxy > 0) app.set("trust proxy", trustProxy);

app.use(helmet());
app.use(
  cors({
    origin: corsOrigin(),
    exposedHeaders: ["authorization"],
  })
);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
});

app.use(passport.initialize());
userPassport(passport);
employeePassport(passport);

app.get("/", (_req, res) => {
  res.send("Plate Vista API");
});

app.get("/health", async (_req, res) => {
  try {
    await connectToDatabase();
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false });
    }
    await mongoose.connection.db.admin().ping();
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(503).json({ ok: false });
  }
});

app.post("/api/v1/ws-ticket", requireAuth, (req, res) => {
  res.status(200).json({ ticket: generateWsTicket(req.user), expiresIn: 60 });
});

app.use("/api/v1/employee", employeeRouter);
app.use("/api/v1/users", userRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/menu-items", menuRouter);
app.use("/api/v1/r", publicMenuRouter);
app.use("/api/v1/orders", orderRouter);
app.use("/api/v1/sessions", sessionRouter);
app.use("/api/v1/table", tableRouter);
app.use("/api/v1/statistics", statisticsRouter);
app.use("/api/v1/staff", staffRouter);
app.use("/internal", internalRouter);

app.use((_req, res) => {
  res.status(404).json({ message: "Not found" });
});

app.use((err, req, res, _next) => {
  logger.error(
    { err, requestId: req.id, restaurantId: req.tenant?.restaurantId || null },
    "request failed"
  );
  captureException(err);
  if (err instanceof AppError) {
    const body = { code: err.code, message: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ message: err.issues[0]?.message || "Invalid request" });
  }
  if (err.name === "TenantError") {
    return res.status(500).json({ message: "Internal server error" });
  }
  if (isDuplicateKey(err)) {
    return res.status(409).json({ message: "Already exists" });
  }
  if (err.name === "ValidationError" || err.name === "CastError") {
    return res.status(400).json({ message: "Invalid request" });
  }
  return res.status(500).json({ message: "Internal server error" });
});

export default app;
