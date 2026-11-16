import Restaurant from "../restaurants/restaurant.model.js";
import { AppError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import {
  assertStripeConfigured,
  createOnboardingLink,
  createPayoutAccount,
  retrievePayoutAccount,
} from "./stripe.js";

// Where Stripe sends the owner back to, whether they finished or the link
// expired. The dashboard page reads the status and offers a new link.
const settingsUrl = () => `${process.env.DASHBOARD_URL.replace(/\/+$/, "")}/settings/payout-account`;

const notFound = () => new AppError("NOT_FOUND", "Restaurant not found");

export const serializePayoutAccount = (restaurant) => {
  const account = restaurant?.payoutAccount;
  return {
    connected: Boolean(account?.stripeAccountId),
    chargesEnabled: Boolean(account?.chargesEnabled),
    detailsSubmitted: Boolean(account?.detailsSubmitted),
  };
};

export const getPayoutAccount = async (restaurantId) => {
  assertStripeConfigured();
  const restaurant = await Restaurant.findById(restaurantId).select("payoutAccount").lean();
  if (!restaurant) throw notFound();
  return serializePayoutAccount(restaurant);
};

// The Payout Account is created once; every later call reuses it, so an owner
// who left onboarding halfway continues where they stopped.
const ensurePayoutAccount = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("payoutAccount").lean();
  if (!restaurant) throw notFound();
  if (restaurant.payoutAccount?.stripeAccountId) return restaurant.payoutAccount.stripeAccountId;

  const account = await createPayoutAccount({ restaurantId });
  // Only the first save wins; a concurrent request reads what it stored.
  const saved = await Restaurant.findOneAndUpdate(
    { _id: restaurantId, "payoutAccount.stripeAccountId": { $exists: false } },
    { $set: { payoutAccount: account } },
    { new: true, projection: { payoutAccount: 1 } }
  ).lean();
  if (saved) return saved.payoutAccount.stripeAccountId;
  const current = await Restaurant.findById(restaurantId).select("payoutAccount").lean();
  if (!current?.payoutAccount?.stripeAccountId) throw notFound();
  return current.payoutAccount.stripeAccountId;
};

// Responds with a Stripe-hosted link where the owner sets up the Payout Account.
export const startPayoutOnboarding = async (restaurantId) => {
  assertStripeConfigured();
  const stripeAccountId = await ensurePayoutAccount(restaurantId);
  const url = await createOnboardingLink({
    stripeAccountId,
    refreshUrl: settingsUrl(),
    returnUrl: settingsUrl(),
  });
  return { url };
};

// Stripe retries and may deliver an event twice or out of order, so the
// handler reads the Payout Account's current state from Stripe instead of
// trusting the (possibly stale) copy in the event, and only ever sets it.
const onAccountUpdated = async (event) => {
  const stripeAccountId = event.data?.object?.id;
  const restaurant = stripeAccountId
    ? await Restaurant.findOne({ "payoutAccount.stripeAccountId": stripeAccountId }).select("_id").lean()
    : null;
  if (!restaurant) {
    logger.warn({ eventId: event.id, stripeAccountId }, "account.updated for an unknown Payout Account; ignored");
    return;
  }
  const account = await retrievePayoutAccount(stripeAccountId);
  await Restaurant.updateOne(
    { _id: restaurant._id, "payoutAccount.stripeAccountId": stripeAccountId },
    {
      $set: {
        "payoutAccount.chargesEnabled": account.chargesEnabled,
        "payoutAccount.detailsSubmitted": account.detailsSubmitted,
      },
    }
  );
};

// One handler per event type; later slices add theirs. Every handler must be
// safe to run twice for the same event.
const HANDLERS = {
  "account.updated": onAccountUpdated,
};

export const handleStripeEvent = async (event) => {
  const handler = HANDLERS[event?.type];
  if (!handler) return;
  await handler(event);
};
