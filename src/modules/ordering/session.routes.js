import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { AppError } from "../../shared/errors.js";
import { checkId, requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { closeSession } from "./session.service.js";
import { getSessionBill } from "./order.service.js";
import { recordPayment } from "../payments/payment.service.js";
import { getReceiptTokenForSession } from "../payments/receipt.service.js";
import { receiptTokenLimiter } from "../../shared/rateLimiters.js";
import { closeSessionSchema } from "../payments/payment.schemas.js";
import { parseOrThrow } from "../../shared/validate.js";
import { canPayBillOnline } from "../payouts/payout.service.js";
import { startOnlinePayment } from "../payments/onlinePayment.service.js";
import { unfreezeBill } from "../payments/unfreeze.js";
import { payPanelOf, presentTestCard, startCardReaderPayment } from "../payments/cardReaderPayment.service.js";

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
    const bill = await getSessionBill(req.tenant, req.params.id);
    // Staff see it too, for information; only a guest acts on it.
    const canPayOnline = await canPayBillOnline(req.tenant.restaurantId, bill);
    const payPanel = await payPanelOf(req.tenant.restaurantId, req.params.id, bill, {
      staff: req.user.role !== "guest",
    });
    res.status(200).json({ ...bill, canPayOnline, ...payPanel });
  })
);

// Polled by the guest's app after paying, until the payment exists. Same
// access as the bill: a guest reaches only their own session, even closed.
sessionRouter.get(
  "/:id/receipt-token",
  receiptTokenLimiter,
  requireAuth,
  requireRole("employee", "guest"),
  requireTenant,
  checkId,
  asyncRoute(async (req, res) => {
    if (req.user.role === "guest" && req.user.sessionId !== req.params.id) {
      throw new AppError("NOT_FOUND", "Not found", 404);
    }
    const result = await getReceiptTokenForSession(req.tenant.restaurantId, req.params.id);
    res.status(result.status === "PAYING" ? 202 : 200).json(result);
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

// A guest of this session, or staff, starts paying the whole bill online.
// The response sends the browser to Stripe.
sessionRouter.post(
  "/:id/online-payment",
  requireAuth,
  requireRole("employee", "guest"),
  requireTenant,
  checkId,
  asyncRoute(async (req, res) => {
    if (req.user.role === "guest" && req.user.sessionId !== req.params.id) {
      throw new AppError("NOT_FOUND", "Not found", 404);
    }
    const result = await startOnlinePayment(
      { restaurantId: req.tenant.restaurantId, requestId: req.id },
      req.params.id
    );
    res.status(200).json(result);
  })
);

// The guest went back from Stripe, or an owner or admin unfreezes the bill by
// hand. Not frozen: nothing to do. Staff win even when Stripe is down; a
// guest then gets 502 and the bill stays frozen until Stripe expires it.
sessionRouter.post(
  "/:id/online-payment/cancel",
  requireAuth,
  requireRole("admin", "guest"),
  requireTenant,
  checkId,
  asyncRoute(async (req, res) => {
    const isGuest = req.user.role === "guest";
    if (isGuest && req.user.sessionId !== req.params.id) {
      throw new AppError("NOT_FOUND", "Not found", 404);
    }
    const result = await unfreezeBill(
      { restaurantId: req.tenant.restaurantId, requestId: req.id },
      req.params.id,
      { evenIfStripeFails: !isGuest }
    );
    res.status(200).json(result);
  })
);

const staffCtx = (req) => ({
  restaurantId: req.tenant.restaurantId,
  requestId: req.id,
  actor: { type: "employee", id: req.user.id, position: req.user.position },
});

// Any staff member sends the bill's total to a card reader (ADR-0008). Only
// Stripe's webhook records the Payment.
sessionRouter.post(
  "/:id/card-reader-payment",
  requireAuth,
  requireRole("employee"),
  requireTenant,
  checkId,
  asyncRoute(async (req, res) => {
    res.status(200).json(await startCardReaderPayment(staffCtx(req), req.params.id, req.body));
  })
);

// Test mode only: taps a Stripe test card on the Simulated Reader.
sessionRouter.post(
  "/:id/card-reader-payment/test-card",
  requireAuth,
  requireRole("employee"),
  requireTenant,
  checkId,
  asyncRoute(async (req, res) => {
    res.status(200).json(await presentTestCard(staffCtx(req), req.params.id, req.body));
  })
);

export default sessionRouter;
