import express from "express";
import passport from "passport";
import { authLimiter, tableJoinLimiter } from "../../shared/rateLimiters.js";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { AppError } from "../../shared/errors.js";
import { requireAuth } from "./auth.middleware.js";
import Restaurant from "../restaurants/restaurant.model.js";
import {
  authenticateOwner,
  authenticateStaff,
  issueTableToken,
  registerRestaurant,
} from "./staff.service.js";
import { issueTokens, revokeRefreshToken, rotateRefreshToken } from "./token.service.js";

const authRouter = express.Router();

// Responds with { accessToken, refreshToken, expiresIn, tokenType }. The access
// token is also sent in the Authorization header for older clients.
// Employee logins also return their restaurant, so the app can build its links.
const login = asyncRoute(async (req, res) => {
  const tokens = await issueTokens(req.user);
  res.setHeader("Authorization", `Bearer ${tokens.accessToken}`);
  const who = req.user.username
    ? { username: req.user.username }
    : { position: req.user.position };
  const restaurant = req.user.restaurantId
    ? await Restaurant.findById(req.user.restaurantId).select("name slug").lean()
    : null;
  res.status(200).json({
    message: "Logged in successfully",
    ...who,
    ...(restaurant && {
      restaurant: { id: restaurant._id, name: restaurant.name, slug: restaurant.slug },
    }),
    ...tokens,
  });
});

authRouter.post(
  "/login",
  authLimiter,
  passport.authenticate("user-local", { session: false, failureMessage: true }),
  login
);

// Body: { restaurant: slug, employee, password }. Staff names are unique only
// inside a restaurant, so the slug says which restaurant to look in.
authRouter.post(
  "/employee/login",
  authLimiter,
  asyncRoute(async (req, _res, next) => {
    req.user = await authenticateStaff(req.body);
    next();
  }),
  login
);

// Body: { email, password }. Dashboard login for restaurant owners only.
authRouter.post(
  "/owner/login",
  authLimiter,
  asyncRoute(async (req, _res, next) => {
    req.user = await authenticateOwner(req.body);
    next();
  }),
  login
);

authRouter.post(
  "/register",
  authLimiter,
  asyncRoute(async (req, res) => {
    const result = await registerRestaurant(req.body);
    const tokens = await issueTokens(result.employee);
    res.setHeader("Authorization", `Bearer ${tokens.accessToken}`);
    res.status(201).json({
      message: "Registered",
      token: tokens.accessToken,
      ...tokens,
      restaurant: {
        id: result.restaurant._id,
        name: result.restaurant.name,
        slug: result.restaurant.slug,
      },
      employee: result.employee.toJSON(),
    });
  })
);

// Exchanges a refresh token for a new access token and a new refresh token.
// The old refresh token stops working; reusing it logs out every device that
// shares its login.
authRouter.post(
  "/refresh",
  asyncRoute(async (req, res) => {
    const tokens = await rotateRefreshToken(req.body);
    res.setHeader("Authorization", `Bearer ${tokens.accessToken}`);
    res.status(200).json(tokens);
  })
);

authRouter.post(
  "/logout",
  asyncRoute(async (req, res) => {
    await revokeRefreshToken(req.body);
    res.status(204).end();
  })
);

authRouter.get(
  "/user",
  requireAuth,
  (req, res) => {
    res.status(200).json({ user: req.user });
  }
);

// Body: { joinCode?, guestToken? }. See docs/frontend-changes.md.
authRouter.post(
  "/table/:qrCode",
  tableJoinLimiter,
  asyncRoute(async (req, res) => {
    if (!req.params.qrCode || req.params.qrCode.length < 8) {
      throw new AppError("NOT_FOUND", "Not found", 404);
    }
    const result = await issueTableToken(req.params.qrCode, req.headers.authorization, req.body);
    res.status(200).json(result);
  })
);

export default authRouter;
