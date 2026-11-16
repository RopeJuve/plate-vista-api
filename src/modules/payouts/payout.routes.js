import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { getPayoutAccount, handleStripeEvent, startPayoutOnboarding } from "./payout.service.js";
import { constructWebhookEvent } from "./stripe.js";

// Mounted under /api/v1/restaurant. The Payout Account is where the
// restaurant's money goes, so only the owner may touch it, not admins.
export const payoutAccountRouter = express.Router();
const ownerOnly = [requireAuth, requireRole("owner"), requireTenant];

payoutAccountRouter.post("/payout-account", ...ownerOnly, asyncRoute(async (req, res) => {
  res.status(200).json(await startPayoutOnboarding(req.tenant.restaurantId));
}));

payoutAccountRouter.get("/payout-account", ...ownerOnly, asyncRoute(async (req, res) => {
  res.status(200).json(await getPayoutAccount(req.tenant.restaurantId));
}));

// Mounted in app.js before express.json(): the signature is over the raw
// bytes, so this route must see the body unparsed. No auth, no tenant; the
// signature is the authentication.
export const stripeWebhookRouter = express.Router();

stripeWebhookRouter.post(
  "/stripe",
  express.raw({ type: "application/json", limit: "1mb" }),
  asyncRoute(async (req, res) => {
    const event = constructWebhookEvent(req.body, req.get("stripe-signature"));
    await handleStripeEvent(event);
    res.status(200).json({ received: true });
  })
);
