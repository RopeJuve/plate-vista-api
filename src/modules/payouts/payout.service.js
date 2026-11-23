import Restaurant from "../restaurants/restaurant.model.js";
import { AppError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { parseOrThrow } from "../../shared/validate.js";
import { isTseActive } from "../tse/tse.service.js";
import { completeOnlinePayment, expireOnlinePayment } from "../payments/onlinePayment.service.js";
import { captureCardReaderAuthorization } from "../payments/cardReaderCapture.service.js";
import { failCardReaderAttempt } from "../payments/cardReaderFailure.service.js";
import { updatePayoutAccountSchema } from "./payout.schemas.js";
import {
  assertStripeConfigured,
  createOnboardingLink,
  createPayoutAccount,
  retrievePayoutAccount,
} from "./stripe.js";

// Where Stripe sends the owner back to, whether they finished (`return`) or the
// link expired (`refresh`). The Payout Account section lives on the Kasse page,
// which reads the status and offers a new link.
const kasseUrl = (payout) => `${process.env.DASHBOARD_URL.replace(/\/+$/, "")}/admin/kasse?payout=${payout}`;

const notFound = () => new AppError("NOT_FOUND", "Restaurant not found");

export const serializePayoutAccount = (restaurant) => {
  const account = restaurant?.payoutAccount;
  return {
    connected: Boolean(account?.stripeAccountId),
    chargesEnabled: Boolean(account?.chargesEnabled),
    detailsSubmitted: Boolean(account?.detailsSubmitted),
    // On unless the owner switched it off; accounts saved before the switch
    // existed have no value and read as on.
    onlinePaymentsEnabled: account?.onlinePaymentsEnabled !== false,
  };
};

// Stores the Payout Account's flags as Stripe has them now. It sets absolute
// values, so running it twice, or after a newer read, changes nothing wrong.
const syncPayoutAccount = async (stripeAccountId) => {
  const { chargesEnabled, detailsSubmitted } = await retrievePayoutAccount(stripeAccountId);
  return Restaurant.findOneAndUpdate(
    { "payoutAccount.stripeAccountId": stripeAccountId },
    {
      $set: {
        "payoutAccount.chargesEnabled": chargesEnabled,
        "payoutAccount.detailsSubmitted": detailsSubmitted,
      },
    },
    { new: true, projection: { payoutAccount: 1 } }
  ).lean();
};

// Until the Payout Account can take payments, every read asks Stripe, so the
// owner coming back from onboarding sees where they are even before an event
// arrives. If Stripe cannot answer, the stored status is shown.
export const getPayoutAccount = async (restaurantId) => {
  assertStripeConfigured();
  const restaurant = await Restaurant.findById(restaurantId).select("payoutAccount").lean();
  if (!restaurant) throw notFound();
  const account = restaurant.payoutAccount;
  if (account?.stripeAccountId && !account.chargesEnabled) {
    try {
      const synced = await syncPayoutAccount(account.stripeAccountId);
      if (synced) return serializePayoutAccount(synced);
    } catch (error) {
      logger.warn({ err: error, restaurantId }, "could not read the Payout Account from Stripe; showing the stored status");
    }
  }
  return serializePayoutAccount(restaurant);
};

// The owner switches online payments off or on. There is nothing to switch
// before the Payout Account exists.
export const updatePayoutAccount = async (restaurantId, input) => {
  assertStripeConfigured();
  const { onlinePaymentsEnabled } = parseOrThrow(updatePayoutAccountSchema, input);
  const restaurant = await Restaurant.findById(restaurantId).select("payoutAccount").lean();
  if (!restaurant) throw notFound();
  const updated = await Restaurant.findOneAndUpdate(
    { _id: restaurantId, "payoutAccount.stripeAccountId": { $type: "string" } },
    { $set: { "payoutAccount.onlinePaymentsEnabled": onlinePaymentsEnabled } },
    { new: true, projection: { payoutAccount: 1 } }
  ).lean();
  if (!updated) {
    throw new AppError("PAYOUT_ACCOUNT_MISSING", "Set up the Payout Account first");
  }
  return serializePayoutAccount(updated);
};

// Whether a guest may pay this bill online right now. Only the answer leaves
// this function; guests never learn why or anything about the Payout Account.
export const canPayBillOnline = async (restaurantId, bill) => {
  if (!process.env.STRIPE_SECRET_KEY) return false;
  if (bill.session?.status !== "open" || bill.payment || !(bill.totalCents > 0)) return false;
  const restaurant = await Restaurant.findById(restaurantId).select("payoutAccount tse.setupStep").lean();
  const account = serializePayoutAccount(restaurant);
  return account.chargesEnabled && account.onlinePaymentsEnabled && isTseActive(restaurant);
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
    refreshUrl: kasseUrl("refresh"),
    returnUrl: kasseUrl("return"),
  });
  return { url };
};

// One handler per event type; later slices add theirs. Every handler must be
// safe to run twice for the same event. The wrappers keep the import cycle
// with the online payments harmless whichever module loads first.
const HANDLERS = {
  "checkout.session.completed": (event) => completeOnlinePayment(event),
  "checkout.session.expired": (event) => expireOnlinePayment(event),
  "payment_intent.amount_capturable_updated": (event) => captureCardReaderAuthorization(event),
  "payment_intent.payment_failed": (event) => failCardReaderAttempt(event),
  "terminal.reader.action_failed": (event) => failCardReaderAttempt(event),
};

export const handleStripeEvent = async (event) => {
  const handler = HANDLERS[event?.type];
  if (!handler) return;
  await handler(event);
};

// Accounts v2 events arrive as thin notifications on their own event
// destination: they name the account that changed and carry no data, so the
// account is read from Stripe. Reading the latest state also makes delivery
// order and repeats harmless.
export const handleAccountEventNotification = async (notification) => {
  const related = notification?.related_object;
  if (!notification?.type?.startsWith("v2.core.account") || related?.type !== "v2.core.account" || !related.id) {
    return;
  }
  const known = await Restaurant.exists({ "payoutAccount.stripeAccountId": related.id });
  if (!known) {
    logger.warn(
      { eventId: notification.id, type: notification.type, stripeAccountId: related.id },
      "Stripe account event for an unknown Payout Account; ignored"
    );
    return;
  }
  await syncPayoutAccount(related.id);
};
