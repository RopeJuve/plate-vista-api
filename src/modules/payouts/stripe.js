// The only file that talks to Stripe. It exposes the handful of calls Plate
// Vista uses, in our words, so the rest of the code never sees the SDK.
// Tests swap the SDK client for test/support/fakeStripe.js; nothing in a test
// reaches Stripe.
import Stripe from "stripe";
import { AppError } from "../../shared/errors.js";

let clientOverride = null;
let defaultClient = null;
let defaultClientKey = null;

// null restores the real client.
export const setStripeClient = (client) => {
  clientOverride = client;
};

const notConfigured = () =>
  new AppError("STRIPE_NOT_CONFIGURED", "Online payments are not set up on this server");

const client = () => {
  if (clientOverride) return clientOverride;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw notConfigured();
  if (!defaultClient || defaultClientKey !== key) {
    defaultClient = new Stripe(key);
    defaultClientKey = key;
  }
  return defaultClient;
};

// Throws STRIPE_NOT_CONFIGURED unless the server can reach Stripe and build
// the dashboard return URLs.
export const assertStripeConfigured = () => {
  client();
  if (!process.env.DASHBOARD_URL) throw notConfigured();
};

const toPayoutAccount = (account) => ({
  stripeAccountId: account.id,
  chargesEnabled: Boolean(account.charges_enabled),
  detailsSubmitted: Boolean(account.details_submitted),
});

// An Express Payout Account in Germany that can take card payments and
// receive transfers. The idempotency key stops two concurrent requests from
// creating two accounts for one restaurant.
export const createPayoutAccount = async ({ restaurantId }) => {
  const account = await client().accounts.create(
    {
      type: "express",
      country: "DE",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: { restaurantId: String(restaurantId) },
    },
    { idempotencyKey: `payout-account-${restaurantId}` }
  );
  return toPayoutAccount(account);
};

export const retrievePayoutAccount = async (stripeAccountId) =>
  toPayoutAccount(await client().accounts.retrieve(stripeAccountId));

// A Stripe-hosted, single-use link where the owner fills in the Payout
// Account's details. Expired or used links send the owner to refreshUrl.
export const createOnboardingLink = async ({ stripeAccountId, refreshUrl, returnUrl }) => {
  const link = await client().accountLinks.create({
    account: stripeAccountId,
    type: "account_onboarding",
    refresh_url: refreshUrl,
    return_url: returnUrl,
  });
  return link.url;
};

// Verifies a webhook's Stripe-Signature against STRIPE_WEBHOOK_SECRET and
// returns the event. rawBody must be the bytes Stripe sent, unparsed.
export const constructWebhookEvent = (rawBody, signature) => {
  const stripe = client();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw notConfigured();
  if (!signature || !Buffer.isBuffer(rawBody)) {
    throw new AppError("STRIPE_SIGNATURE_INVALID", "Invalid webhook signature");
  }
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    if (error?.type === "StripeSignatureVerificationError") {
      throw new AppError("STRIPE_SIGNATURE_INVALID", "Invalid webhook signature");
    }
    throw error;
  }
};
