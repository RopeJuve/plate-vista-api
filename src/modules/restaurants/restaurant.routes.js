import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { getLegalDetails, updateLegalDetails } from "./legal.js";

const restaurantRouter = express.Router();
// "admin" also admits the owner.
const manage = [requireAuth, requireRole("admin"), requireTenant];

restaurantRouter.get("/legal", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json(await getLegalDetails(req.tenant.restaurantId));
}));

restaurantRouter.put("/legal", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json(await updateLegalDetails(req.tenant.restaurantId, req.body));
}));

export default restaurantRouter;
