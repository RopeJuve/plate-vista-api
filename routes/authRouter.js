import express from "express";
import passport from "passport";
import { jwtSingToken, requireAuth } from "../middlewares/jwtMiddlewares.js";
import {
  authenticateWithToken,
  login,
} from "../controllers/authControllers.js";

const authRouter = express.Router();

authRouter.post(
  "/login",
  passport.authenticate("user-local", { session: false, failureMessage: true }),
  jwtSingToken,
  login
);
authRouter.get("/user", requireAuth, authenticateWithToken);
authRouter.post(
  "/employee/login",
  passport.authenticate("employee-local", { session: false, failureMessage: true }),
  jwtSingToken,
  login
);

export default authRouter;
