import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { getTseStatus, setupTse } from "./tse.service.js";

const tseRouter = express.Router();
// "admin" also admits the owner.
const manage = [requireAuth, requireRole("admin"), requireTenant];

tseRouter.get("/", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json(await getTseStatus(req.tenant.restaurantId));
}));

tseRouter.post("/setup", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json(await setupTse(req.tenant.restaurantId));
}));

export default tseRouter;
