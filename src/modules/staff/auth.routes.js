import express from "express";
import passport from "passport";
import { authLimiter } from "../../../middlewares/rateLimiters.js";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { AppError } from "../../shared/errors.js";
import {
  jwtSingToken,
  requireAuth,
} from "./auth.middleware.js";
import { issueTableToken, registerRestaurant } from "./staff.service.js";

const authRouter = express.Router();

const login = (req, res) => {
  if (req.user.username) {
    return res.status(200).json({ message: "Logged in successfully", username: req.user.username });
  }
  return res.status(200).json({ message: "Logged in successfully", position: req.user.position });
};

authRouter.post(
  "/login",
  authLimiter,
  passport.authenticate("user-local", { session: false, failureMessage: true }),
  jwtSingToken,
  login
);

authRouter.post(
  "/employee/login",
  authLimiter,
  passport.authenticate("employee-local", { session: false, failureMessage: true }),
  jwtSingToken,
  login
);

authRouter.post(
  "/register",
  authLimiter,
  asyncRoute(async (req, res) => {
    const result = await registerRestaurant(req.body);
    res.setHeader("Authorization", `Bearer ${result.token}`);
    res.status(201).json({
      message: "Registered",
      token: result.token,
      restaurant: {
        id: result.restaurant._id,
        name: result.restaurant.name,
        slug: result.restaurant.slug,
      },
      employee: result.employee.toJSON(),
    });
  })
);

authRouter.get(
  "/user",
  requireAuth,
  (req, res) => {
    res.status(200).json({ user: req.user });
  }
);

authRouter.post(
  "/table/:qrCode",
  asyncRoute(async (req, res) => {
    if (!req.params.qrCode || req.params.qrCode.length < 8) {
      throw new AppError("NOT_FOUND", "Not found", 404);
    }
    const result = await issueTableToken(req.params.qrCode, req.headers.authorization);
    res.status(200).json(result);
  })
);

export default authRouter;
