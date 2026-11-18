import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { listOnlinePaymentRefunds } from "./latePayment.service.js";

// Mounted under /api/v1/restaurant. "admin" also admits the owner.
const refundRouter = express.Router();
const manage = [requireAuth, requireRole("admin"), requireTenant];

refundRouter.get("/online-payment-refunds", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json(await listOnlinePaymentRefunds(req.tenant.restaurantId, req.query));
}));

export default refundRouter;
