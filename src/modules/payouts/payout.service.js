import Restaurant from "../restaurants/restaurant.model.js";
import { AppError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import {
  assertStripeConfigured,
  createOnboardingLink,
  createPayoutAccount,
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

// Copies the Payout Account's flags from the event. It sets absolute values
// rather than toggling, so a second delivery of the same event changes nothing.
const onAccountUpdated = async (event) => {
  const object = event.data?.object;
  const stripeAccountId = object?.id;
  const restaurant = stripeAccountId
    ? await Restaurant.findOne({ "payoutAccount.stripeAccountId": stripeAccountId }).select("_id").lean()
    : null;
  if (!restaurant) {
    logger.warn({ eventId: event.id, stripeAccountId }, "account.updated for an unknown Payout Account; ignored");
    return;
  }
  await Restaurant.updateOne(
    { _id: restaurant._id, "payoutAccount.stripeAccountId": stripeAccountId },
    {
      $set: {
        "payoutAccount.chargesEnabled": Boolean(object.charges_enabled),
        "payoutAccount.detailsSubmitted": Boolean(object.details_submitted),
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
