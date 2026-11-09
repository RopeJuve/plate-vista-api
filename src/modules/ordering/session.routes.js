import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { AppError } from "../../shared/errors.js";
import { checkId, requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { closeSession } from "./session.service.js";
import { getSessionBill } from "./order.service.js";
import { recordPayment } from "../payments/payment.service.js";
import { closeSessionSchema } from "../payments/payment.schemas.js";
import { parseOrThrow } from "../../shared/validate.js";

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
    const { unpaidReason } = parseOrThrow(closeSessionSchema, req.body || {});
    const session = await closeSession(
      {
        restaurantId: req.tenant.restaurantId,
        actor: { type: "employee", id: req.user.id, position: req.user.position },
      },
      req.params.id,
      { unpaidReason }
    );
    res.status(200).json({
      id: session._id,
      status: session.status,
      tableId: session.tableId,
      closedAt: session.closedAt,
    });
  })
);

// Any staff member records that the bill was paid at the table.
sessionRouter.post(
  "/:id/payments",
  requireAuth,
  requireRole("employee"),
  requireTenant,
  checkId,
  asyncRoute(async (req, res) => {
    const { payment, replayed } = await recordPayment(
      {
        restaurantId: req.tenant.restaurantId,
        requestId: req.id,
        actor: { type: "employee", id: req.user.id, position: req.user.position },
      },
      req.params.id,
      req.body
    );
    res.status(replayed ? 200 : 201).json(payment);
  })
);

export default sessionRouter;
