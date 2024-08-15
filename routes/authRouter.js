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
