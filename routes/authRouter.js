import express from "express";
import passport from "passport";
import { jwtSingToken, jwtVerifyToken } from "../middlewares/jwtMiddlewares.js";
import {
  authenticateWithToken,
  login,
} from "../controllers/authControllers.js";

const authRouter = express.Router();

authRouter.post(
  "/login",
  passport.authenticate("user-local", { failureMessage: true }),
  jwtSingToken,
  login
);
authRouter.get("/user", jwtVerifyToken, authenticateWithToken);
authRouter.post(
  "/employee/login",
  passport.authenticate("employee-local", { failureMessage: true }),
  jwtSingToken,
  login
);

export default authRouter;

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Login user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Login successful
 *         headers:
 *           authorization:
 *             schema:
 *               type: string
 *       401:
 *         description: Invalid credentials
 * 
 * /auth/employee/login:
 *   post:
 *     summary: Login employee
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Login successful
 */
