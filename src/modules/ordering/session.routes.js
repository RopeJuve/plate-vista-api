import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { AppError } from "../../shared/errors.js";
import { checkId, requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { closeSession } from "./session.service.js";
import { getSessionBill } from "./order.service.js";

const sessionRouter = express.Router();

// Staff read any session of their restaurant; a guest reads only the session
// bound to their table token, even after it is closed.
sessionRouter.get(
  "/:id/bill",
  requireAuth,
  requireRole("employee", "guest"),
  requireTenant,
  checkId,
  asyncRoute(async (req, res) => {
    if (req.user.role === "guest" && req.user.sessionId !== req.params.id) {
      throw new AppError("NOT_FOUND", "Not found", 404);
    }
    res.status(200).json(await getSessionBill(req.tenant, req.params.id));
  })
);

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
