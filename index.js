import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import connectToDatabase from "./db/db.js";
import passport from "passport";
import userPassport from "./strategies/userPassport.js";
import employeePassport from "./strategies/employeePassport.js";
import {
  userRouter,
  authRouter,
  menuItemRouter,
  orderRouter,
  employeeRouter,
  tableRouter,
  statisticsRouter,
} from "./routes/index.js";
import { wsServer } from "./wss.js";

dotenv.config();

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

const REQUIRED_ENV_VARS = ["JWT_SECRET", "MONGO_DB_URL"];
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(
    `Missing required environment variable(s): ${missingEnvVars.join(", ")}`
  );
  process.exit(1);
}

const app = express();

const PORT = process.env.PORT || 8080;
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",")
  : undefined;

app.use(helmet());
app.use(
  cors({
    origin: CORS_ORIGIN,
    exposedHeaders: ["authorization"],
  })
);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

app.use(passport.initialize());
userPassport(passport);
employeePassport(passport);

app.get("/", (req, res) => {
  res.send("Plate Vista API");
});

app.use("/api/v1/employee", employeeRouter);
app.use("/api/v1/users", userRouter);
app.use("/api/v1/auth", authRouter);

app.use("/api/v1/menu-items", menuItemRouter);
app.use("/api/v1/orders", orderRouter);
app.use("/api/v1/table", tableRouter);

app.use("/api/v1/statistics", statisticsRouter);

await connectToDatabase();

// Vercel serverless functions invoke this module per-request and don't
// support a long-lived `ws` server or app.listen(); the WebSocket feature
// (and this app in general) needs a persistent Node host (Railway, Render,
// Fly.io, etc). Only bind a real listener outside that environment.
if (!process.env.VERCEL) {
  const s = app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
  wsServer(s);
}

export default app;
