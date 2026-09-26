import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { checkId, requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { closeSession } from "./session.service.js";

const sessionRouter = express.Router();

sessionRouter.post(
  "/:id/close",
  requireAuth,
  requireRole("employee"),
  requireTenant,
  checkId,
  asyncRoute(async (req, res) => {
    const session = await closeSession(
      { restaurantId: req.tenant.restaurantId, actor: { type: "employee", id: req.user.id } },
      req.params.id
    );
    res.status(200).json({
      id: session._id,
      status: session.status,
      tableId: session.tableId,
      closedAt: session.closedAt,
    });
  })
);

export default sessionRouter;
