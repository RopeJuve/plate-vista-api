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

// Throws STRIPE_NOT_CONFIGURED unless the server can reach Stripe and build
// the URLs that send a guest back to their table.
export const assertOnlinePaymentsConfigured = () => {
  client();
  if (!process.env.GUEST_APP_URL) throw notConfigured();
};

// Requirements the owner still has to fill in before Stripe can decide.
const OWNER_DUE = new Set(["currently_due", "past_due"]);

// The Payout Account as Plate Vista keeps it. `chargesEnabled` is the card
// payments capability being active. `detailsSubmitted` means the owner has
// nothing left to fill in: Stripe may still be reviewing. Without the
// requirements in the response we cannot tell, so it reads as not submitted.
const toPayoutAccount = (account) => {
  const chargesEnabled = account.configuration?.merchant?.capabilities?.card_payments?.status === "active";
  const entries = account.requirements ? account.requirements.entries ?? [] : null;
  const ownerHasWork =
    entries === null ||
    entries.some(
      (entry) => entry.awaiting_action_from === "user" && OWNER_DUE.has(entry.minimum_deadline?.status)
    );
  return {
    stripeAccountId: account.id,
    chargesEnabled,
    detailsSubmitted: chargesEnabled || !ownerHasWork,
  };
};

// What every Payout Account read asks Stripe to include; both are null otherwise.
const INCLUDE = ["configuration.merchant", "requirements"];

// A Payout Account in Germany created with Accounts v2 (ADR-0006). The
// restaurant takes direct charges as the merchant, so it gets the merchant
// configuration with card payments, its own full Stripe Dashboard, and pays
// Stripe's fees itself; Stripe, not Plate Vista, carries negative balances.
// The owner fills in the rest on Stripe's onboarding. The idempotency key
// stops two concurrent requests from creating two accounts for one
// restaurant; its "v2-" part keeps it apart from keys Stripe still remembers
// for the old v1 request, which it would refuse with different parameters.
export const createPayoutAccount = async ({ restaurantId }) => {
  const account = await client().v2.core.accounts.create(
    {
      dashboard: "full",
      identity: { country: "de" },
      configuration: {
        merchant: {
          capabilities: { card_payments: { requested: true } },
        },
      },
      defaults: {
        currency: "eur",
        responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
      },
      metadata: { restaurantId: String(restaurantId) },
      include: INCLUDE,
    },
    { idempotencyKey: `payout-account-v2-${restaurantId}` }
  );
  return toPayoutAccount(account);
};

export const retrievePayoutAccount = async (stripeAccountId) =>
  toPayoutAccount(await client().v2.core.accounts.retrieve(stripeAccountId, { include: INCLUDE }));

// A Stripe-hosted, single-use link where the owner fills in the Payout
// Account's details. Expired or used links send the owner to refreshUrl.
// Everything Stripe will ever need is asked for at once, so the owner is not
// sent back later for more.
export const createOnboardingLink = async ({ stripeAccountId, refreshUrl, returnUrl }) => {
  const link = await client().v2.core.accountLinks.create({
    account: stripeAccountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        collection_options: { fields: "eventually_due" },
        refresh_url: refreshUrl,
        return_url: returnUrl,
      },
    },
  });
  return link.url;
};

// A Stripe Checkout Session for the whole bill, as a direct charge on the
// restaurant's Payout Account (ADR-0006). Each line is one receipt line, so
// Stripe's total is the bill's. A repeated attemptId returns the Checkout
// Session Stripe made the first time instead of a second one.
export const createOnlinePaymentCheckout = async ({
  stripeAccountId,
  attemptId,
  lines,
  amountCents,
  applicationFeeCents,
  expiresAt,
  successUrl,
  cancelUrl,
  metadata,
}) => {
  const checkout = await client().checkout.sessions.create(
    {
      mode: "payment",
      line_items: lines.map((line) => ({
        quantity: line.quantity,
        price_data: {
          currency: "eur",
          unit_amount: line.unitPriceCents,
          product_data: { name: line.title },
        },
      })),
      expires_at: Math.floor(expiresAt.getTime() / 1000),
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { ...metadata, amountCents: String(amountCents) },
      ...(applicationFeeCents > 0
        ? { payment_intent_data: { application_fee_amount: applicationFeeCents } }
        : {}),
    },
    { stripeAccount: stripeAccountId, idempotencyKey: `online-payment-${attemptId}` }
  );
  return { checkoutSessionId: checkout.id, url: checkout.url };
};

// Reads a Checkout Session from the restaurant's Payout Account, as Stripe
// keeps it now: the same object `checkout.session.completed` carries.
export const retrieveOnlinePaymentCheckout = ({ stripeAccountId, checkoutSessionId }) =>
  client().checkout.sessions.retrieve(checkoutSessionId, {}, { stripeAccount: stripeAccountId });

const fromUnix = (seconds) => (Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined);

// What the guest's receipt shows about how they paid, from a Checkout Session
// whose payment_intent.latest_charge is expanded; null without a charge.
export const onlinePaymentDetailsOf = (checkout) => {
  const intent = checkout?.payment_intent;
  const charge = intent && typeof intent === "object" ? intent.latest_charge : null;
  const method = charge && typeof charge === "object" ? charge.payment_method_details : null;
  if (!method?.type) return null;
  const card = method.type === "card" ? method.card || {} : {};
  const details = {
    type: method.type,
    brand: card.brand,
    last4: card.last4,
    funding: card.funding,
    wallet: card.wallet?.type,
    authorizationCode: card.authorization_code,
    paymentIntentId: intent.id,
    authorizedAt: fromUnix(charge.created),
  };
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value != null && value !== ""));
};

// How the guest paid a Checkout Session on the restaurant's Payout Account
// (onlinePaymentDetailsOf); null when Stripe has no charge for it.
export const retrieveOnlinePaymentDetails = async ({ stripeAccountId, checkoutSessionId }) =>
  onlinePaymentDetailsOf(
    await client().checkout.sessions.retrieve(
      checkoutSessionId,
      { expand: ["payment_intent.latest_charge"] },
      { stripeAccount: stripeAccountId }
    )
  );

// Expires a Checkout Session on the restaurant's Payout Account so the guest
// can no longer pay it. Returns "expired", or "complete" when the guest has
// paid it already (Stripe expires only an open one). Any other failure throws.
export const expireOnlinePaymentCheckout = async ({ stripeAccountId, checkoutSessionId }) => {
  const stripe = client();
  try {
    await stripe.checkout.sessions.expire(checkoutSessionId, {}, { stripeAccount: stripeAccountId });
    return "expired";
  } catch (error) {
    if (error?.type !== "StripeInvalidRequestError") throw error;
    // Not open any more: ask Stripe what it is now.
    const checkout = await stripe.checkout.sessions.retrieve(checkoutSessionId, {}, { stripeAccount: stripeAccountId });
    if (checkout.status === "complete") return "complete";
    if (checkout.status === "expired") return "expired";
    throw error;
  }
};

// Verifies a thin event notification (Accounts v2 events arrive this way)
// against STRIPE_ACCOUNT_WEBHOOK_SECRET, the signing secret of its own event
// destination, and returns it. It names the changed object but carries none
// of its data. rawBody must be the bytes Stripe sent, unparsed.
export const parseAccountEventNotification = (rawBody, signature) => {
  const stripe = client();
  const secret = process.env.STRIPE_ACCOUNT_WEBHOOK_SECRET;
  if (!secret) throw notConfigured();
  if (!signature || !Buffer.isBuffer(rawBody)) {
    throw new AppError("STRIPE_SIGNATURE_INVALID", "Invalid webhook signature");
  }
  try {
    return stripe.parseEventNotification(rawBody, signature, secret);
  } catch (error) {
    throw webhookError(error, rawBody, "thin");
  }
};

// The SDK refuses a correctly signed event of the other payload style (its
// message differs between builds, so the payload is looked at instead): the
// event destination was set up with the wrong one. Says which it must be.
const PAYLOAD_OBJECT = { thin: "v2.core.event", snapshot: "event" };
const payloadObjectOf = (rawBody) => {
  try {
    return JSON.parse(rawBody.toString("utf8"))?.object;
  } catch {
    return undefined;
  }
};
const webhookError = (error, rawBody, wanted) => {
  if (error?.type === "StripeSignatureVerificationError") {
    return new AppError("STRIPE_SIGNATURE_INVALID", "Invalid webhook signature");
  }
  const sent = payloadObjectOf(rawBody);
  if (sent && sent !== PAYLOAD_OBJECT[wanted] && Object.values(PAYLOAD_OBJECT).includes(sent)) {
    return new AppError(
      "STRIPE_WEBHOOK_WRONG_PAYLOAD",
      `This webhook route takes ${wanted} events; set the Stripe event destination's payload to ${wanted} (docs/third-party-apis.md)`
    );
  }
  return error;
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
    throw webhookError(error, rawBody, "snapshot");
  }
};

// Refunds a Late Payment in full on the restaurant's Payout Account, with the
// platform fee given back too. The Checkout Session id is the idempotency
// key, so a retried webhook never refunds twice.
export const refundOnlinePayment = async ({ stripeAccountId, paymentIntentId, checkoutSessionId }) => {
  const refund = await client().refunds.create(
    { payment_intent: paymentIntentId, refund_application_fee: true },
    { stripeAccount: stripeAccountId, idempotencyKey: checkoutSessionId }
  );
  return { refundId: refund.id };
};

// Stripe Terminal (ADR-0008). Card readers and their Location live on the
// restaurant's Payout Account.

// Throws STRIPE_NOT_CONFIGURED unless the server can reach Stripe.
export const assertTerminalConfigured = () => {
  client();
};

// Test mode: the server runs on Stripe test keys, the only place Simulated
// Readers exist.
export const isStripeTestMode = () => /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY || "");

// What Stripe registers to make a Simulated (WisePOS E) Reader.
const SIMULATED_REGISTRATION_CODE = "simulated-wpe";

// The one Terminal Location a restaurant's readers are registered under, made
// from its legal address. The idempotency key stops two first readers from
// making two Locations.
export const createTerminalLocation = async ({ stripeAccountId, restaurantId, displayName, address }) => {
  const location = await client().terminal.locations.create(
    {
      display_name: displayName,
      address: {
        line1: address.street,
        postal_code: address.zip,
        city: address.city,
        country: address.country || "DE",
      },
    },
    { stripeAccount: stripeAccountId, idempotencyKey: `terminal-location-${restaurantId}` }
  );
  return location.id;
};

const toCardReader = (reader) => ({
  stripeReaderId: reader.id,
  deviceType: reader.device_type,
  serialNumber: reader.serial_number,
  status: reader.status === "online" ? "online" : "offline",
});

// Stripe refuses a code it does not know, one that expired, or one whose
// reader is registered already; it names registration_code as the culprit.
const isRegistrationCodeError = (error) =>
  error?.type === "StripeInvalidRequestError" && error.param === "registration_code";

// Registers a reader under the Location by the code it shows on screen, or a
// Simulated Reader when simulated is set (test mode only). Throws
// CARD_READER_CODE_INVALID with Stripe's reason when Stripe refuses the code.
export const registerCardReader = async ({ stripeAccountId, locationId, registrationCode, label, simulated = false }) => {
  try {
    const reader = await client().terminal.readers.create(
      {
        registration_code: simulated ? SIMULATED_REGISTRATION_CODE : registrationCode,
        label,
        location: locationId,
      },
      { stripeAccount: stripeAccountId }
    );
    return toCardReader(reader);
  } catch (error) {
    if (!simulated && isRegistrationCodeError(error)) {
      throw new AppError(
        "CARD_READER_CODE_INVALID",
        "The registration code is invalid, expired or already used.",
        undefined,
        { reason: error.message }
      );
    }
    throw error;
  }
};

// Every reader registered under the Location, with the status Stripe last
// heard from it.
export const listCardReaders = async ({ stripeAccountId, locationId }) => {
  const readers = [];
  let startingAfter;
  for (;;) {
    const page = await client().terminal.readers.list(
      { location: locationId, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
      { stripeAccount: stripeAccountId }
    );
    readers.push(...page.data.map(toCardReader));
    if (!page.has_more || page.data.length === 0) return readers;
    startingAfter = page.data[page.data.length - 1].id;
  }
};

// Removes a reader from the Payout Account; one already gone counts as removed.
export const removeCardReader = async ({ stripeAccountId, stripeReaderId }) => {
  try {
    await client().terminal.readers.del(stripeReaderId, {}, { stripeAccount: stripeAccountId });
  } catch (error) {
    if (error?.type === "StripeInvalidRequestError" && (error.statusCode === 404 || error.code === "resource_missing")) {
      return;
    }
    throw error;
  }
};

// Card reader payments (ADR-0008): a card-present PaymentIntent on the Payout
// Account, captured by hand only while its bill is still frozen for it, and
// handed to the reader to collect. Each call carries an idempotency key from
// the attempt, so a repeated start is one PaymentIntent and one reader request.
export const createCardReaderPaymentIntent = async ({
  stripeAccountId,
  attemptId,
  amountCents,
  applicationFeeCents,
  metadata,
}) => {
  const intent = await client().paymentIntents.create(
    {
      amount: amountCents,
      currency: "eur",
      // Since API 2026-09-30 Stripe refuses payment_method_types; this narrows
      // the account's Dashboard methods to the in-person card one.
      allowed_payment_method_types: ["card_present"],
      capture_method: "manual",
      metadata,
      ...(applicationFeeCents > 0 ? { application_fee_amount: applicationFeeCents } : {}),
    },
    { stripeAccount: stripeAccountId, idempotencyKey: `card-reader-payment-${attemptId}` }
  );
  return { paymentIntentId: intent.id };
};

// Tells the reader to ask for a card for the PaymentIntent.
export const collectOnCardReader = async ({ stripeAccountId, stripeReaderId, paymentIntentId, attemptId }) => {
  await client().terminal.readers.processPaymentIntent(
    stripeReaderId,
    { payment_intent: paymentIntentId },
    { stripeAccount: stripeAccountId, idempotencyKey: `card-reader-collect-${attemptId}` }
  );
};

// Stops the reader asking for a card for this PaymentIntent. A reader doing
// nothing, or by now collecting another PaymentIntent, is left alone.
export const stopCollectingOnCardReader = async ({ stripeAccountId, stripeReaderId, paymentIntentId }) => {
  const reader = await client().terminal.readers.retrieve(stripeReaderId, {}, { stripeAccount: stripeAccountId });
  const action = reader?.action;
  if (action?.status !== "in_progress" || action.process_payment_intent?.payment_intent !== paymentIntentId) return;
  try {
    await client().terminal.readers.cancelAction(stripeReaderId, {}, { stripeAccount: stripeAccountId });
  } catch (error) {
    // It finished or stopped between the two calls.
    if (error?.type === "StripeInvalidRequestError") return;
    throw error;
  }
};

// Cancels a card reader PaymentIntent, releasing any authorization, so it can
// never be captured. One already cancelled, or not on that account, counts
// as cancelled.
export const cancelCardReaderPaymentIntent = async ({ stripeAccountId, paymentIntentId }) => {
  try {
    await client().paymentIntents.cancel(paymentIntentId, {}, { stripeAccount: stripeAccountId });
  } catch (error) {
    if (error?.type === "StripeInvalidRequestError" && (error.statusCode === 404 || error.code === "resource_missing")) {
      return;
    }
    if (error?.code !== "payment_intent_unexpected_state") throw error;
    const intent = await client().paymentIntents.retrieve(paymentIntentId, {}, { stripeAccount: stripeAccountId });
    if (intent.status !== "canceled") throw error;
  }
};

// Stripe's test cards (test mode only), by the contract's TestCard names.
export const TEST_CARD_NUMBERS = {
  APPROVED: "4242424242424242",
  DECLINED: "4000000000000002",
  INSUFFICIENT_FUNDS: "4000000000009995",
  LOST_CARD: "4000000000009987",
  STOLEN_CARD: "4000000000009979",
  EXPIRED_CARD: "4000000000000069",
  PROCESSING_ERROR: "4000000000000119",
};

// A card reader PaymentIntent as Stripe keeps it now: its status, amount and
// why its last card failed (Stripe's last_payment_error, or null).
export const retrieveCardReaderPaymentIntent = async ({ stripeAccountId, paymentIntentId }) => {
  const intent = await client().paymentIntents.retrieve(paymentIntentId, {}, { stripeAccount: stripeAccountId });
  return { status: intent.status, amountCents: intent.amount, lastPaymentError: intent.last_payment_error ?? null };
};

// Presents a test card on a Simulated Reader through Stripe's test helpers.
export const presentTestCard = async ({ stripeAccountId, stripeReaderId, card }) => {
  await client().testHelpers.terminal.readers.presentPaymentMethod(
    stripeReaderId,
    { type: "card_present", card_present: { number: TEST_CARD_NUMBERS[card] } },
    { stripeAccount: stripeAccountId }
  );
};

// What a card receipt needs about a card taken on a reader, from a
// PaymentIntent whose latest_charge is expanded; null without a card-present
// charge. Only these fields are kept: never the PAN, expiry, cardholder
// name, cryptogram or anything else Stripe sends about the card.
export const cardPresentDetailsOf = (intent) => {
  const charge = intent && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  const method = charge?.payment_method_details;
  if (method?.type !== "card_present" || !method.card_present) return null;
  const card = method.card_present;
  const details = {
    type: "card_present",
    brand: card.brand,
    last4: card.last4,
    funding: card.funding,
    authorizationCode: card.receipt?.authorization_code,
    aid: card.receipt?.dedicated_file_name,
    applicationLabel: card.receipt?.application_preferred_name,
    readMethod: card.read_method,
    paymentIntentId: intent.id,
    authorizedAt: fromUnix(charge.created),
  };
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value != null && value !== ""));
};

// The card-present details of a card reader PaymentIntent on the restaurant's
// Payout Account (cardPresentDetailsOf); null when it has no such charge.
export const retrieveCardReaderPaymentDetails = async ({ stripeAccountId, paymentIntentId }) =>
  cardPresentDetailsOf(
    await client().paymentIntents.retrieve(
      paymentIntentId,
      { expand: ["latest_charge"] },
      { stripeAccount: stripeAccountId }
    )
  );

// Captures an authorized card reader payment. The key comes from the
// PaymentIntent, so a redelivered webhook never captures twice.
export const captureCardReaderPayment = async ({ stripeAccountId, paymentIntentId }) => {
  await client().paymentIntents.capture(
    paymentIntentId,
    {},
    { stripeAccount: stripeAccountId, idempotencyKey: `card-reader-capture-${paymentIntentId}` }
  );
};
