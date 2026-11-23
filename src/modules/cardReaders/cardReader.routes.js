import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { addCardReader, addSimulatedReader, listCardReaders, removeCardReader } from "./cardReader.service.js";

// Mounted under /api/v1/restaurant. "admin" also admits the owner.
const cardReaderRouter = express.Router();
const manage = [requireAuth, requireRole("admin"), requireTenant];

cardReaderRouter.get("/card-readers", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json(await listCardReaders(req.tenant.restaurantId));
}));

cardReaderRouter.post("/card-readers", ...manage, asyncRoute(async (req, res) => {
  res.status(201).json(await addCardReader(req.tenant.restaurantId, req.body));
}));

cardReaderRouter.post("/card-readers/simulated", ...manage, asyncRoute(async (req, res) => {
  res.status(201).json(await addSimulatedReader(req.tenant.restaurantId, req.body));
}));

cardReaderRouter.delete("/card-readers/:id", ...manage, asyncRoute(async (req, res) => {
  await removeCardReader(req.tenant.restaurantId, req.params.id);
  res.status(204).end();
}));

export default cardReaderRouter;
