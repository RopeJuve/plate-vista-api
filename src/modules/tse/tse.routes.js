import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { AppError } from "../../shared/errors.js";
import { getTseStatus, setupTse } from "./tse.service.js";
import { countFailedSignatures, listFailedSignatures } from "./failedSignatures.js";
import { retryFailedSignature } from "./signing.service.js";

const tseRouter = express.Router();
// "admin" also admits the owner.
const manage = [requireAuth, requireRole("admin"), requireTenant];

tseRouter.get("/", ...manage, asyncRoute(async (req, res) => {
  const { restaurantId } = req.tenant;
  const failedSignatures = await countFailedSignatures(restaurantId);
  res.status(200).json(await getTseStatus(restaurantId, { failedSignatures }));
}));

tseRouter.get("/failed", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json({ items: await listFailedSignatures(req.tenant.restaurantId) });
}));

// Signs it now and answers with the outcome (#29).
tseRouter.post("/failed/:kind/:id/retry", ...manage, asyncRoute(async (req, res) => {
  const status = await retryFailedSignature(req.tenant.restaurantId, req.params);
  if (!status) throw new AppError("NOT_FOUND", "Failed signature not found");
  res.status(200).json({ status });
}));

tseRouter.post("/setup", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json(await setupTse(req.tenant.restaurantId));
}));

export default tseRouter;
