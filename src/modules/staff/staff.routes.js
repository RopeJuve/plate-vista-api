import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { requireAuth, requireRole, requireTenant } from "./auth.middleware.js";
import { getBoard } from "../ordering/session.service.js";

const staffRouter = express.Router();

staffRouter.get(
  "/board",
  requireAuth,
  requireRole("employee"),
  requireTenant,
  asyncRoute(async (req, res) => {
    res.status(200).json(await getBoard(req.tenant.restaurantId));
  })
);

export default staffRouter;
