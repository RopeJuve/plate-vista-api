import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import {
  getPayoutAccount,
  handleAccountEventNotification,
  handleStripeEvent,
  startPayoutOnboarding,
  updatePayoutAccount,
} from "./payout.service.js";
import { constructWebhookEvent, parseAccountEventNotification } from "./stripe.js";

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

payoutAccountRouter.patch("/payout-account", ...ownerOnly, asyncRoute(async (req, res) => {
  res.status(200).json(await updatePayoutAccount(req.tenant.restaurantId, req.body));
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

// Accounts v2 events (the Payout Account's requirements and capabilities)
// come from a separate event destination with thin payloads and its own
// signing secret, STRIPE_ACCOUNT_WEBHOOK_SECRET.
stripeWebhookRouter.post(
  "/stripe/accounts",
  express.raw({ type: "application/json", limit: "1mb" }),
  asyncRoute(async (req, res) => {
    const notification = parseAccountEventNotification(req.body, req.get("stripe-signature"));
    await handleAccountEventNotification(notification);
    res.status(200).json({ received: true });
  })
);
