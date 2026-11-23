// Contract test: runs Plate Vista's own Stripe calls (src/modules/payouts/stripe.js)
// against Stripe test mode, so a call Stripe's API version refuses fails here,
// not at the till. test/support/fakeStripe.js only knows what we told it.
//
// Runs only with a test-mode STRIPE_SECRET_KEY and STRIPE_TEST_ACCOUNT_ID (a
// connected test account that can take card payments); skips otherwise.
// `npm run test:stripe` reads them from .env.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import {
  captureCardReaderPayment,
  cancelCardReaderPaymentIntent,
  collectOnCardReader,
  createCardReaderPaymentIntent,
  createOnlinePaymentCheckout,
  createTerminalLocation,
  expireOnlinePaymentCheckout,
  isStripeTestMode,
  listCardReaders,
  presentTestCard,
  registerCardReader,
  removeCardReader,
  retrieveCardReaderPaymentDetails,
  retrieveCardReaderPaymentIntent,
  retrieveOnlinePaymentCheckout,
  retrievePayoutAccount,
  stopCollectingOnCardReader,
} from "../../src/modules/payouts/stripe.js";

const stripeAccountId = process.env.STRIPE_TEST_ACCOUNT_ID;
const skip =
  !isStripeTestMode() || !stripeAccountId
    ? "needs a test-mode STRIPE_SECRET_KEY and STRIPE_TEST_ACCOUNT_ID"
    : false;

// Stripe settles a Simulated Reader's card a moment after the test helper.
const waitForStatus = async (paymentIntentId, wanted) => {
  let intent;
  for (let i = 0; i < 20; i += 1) {
    intent = await retrieveCardReaderPaymentIntent({ stripeAccountId, paymentIntentId });
    if (wanted.includes(intent.status)) return intent;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`PaymentIntent ${paymentIntentId} stayed ${intent.status}, wanted ${wanted.join(" or ")}`);
};

describe("Stripe contract (test mode)", { skip }, () => {
  // Cleanup only; the calls under test go through src/modules/payouts/stripe.js.
  const sdk = skip ? null : new Stripe(process.env.STRIPE_SECRET_KEY);
  const run = randomUUID();
  let locationId;
  let stripeReaderId;

  before(async () => {
    locationId = await createTerminalLocation({
      stripeAccountId,
      restaurantId: `contract-${run}`,
      displayName: `Contract test ${run.slice(0, 8)}`,
      address: { street: "Teststraße 1", zip: "10115", city: "Berlin", country: "DE" },
    });
    ({ stripeReaderId } = await registerCardReader({
      stripeAccountId,
      locationId,
      label: "Contract test",
      simulated: true,
    }));
  });

  after(async () => {
    if (stripeReaderId) await removeCardReader({ stripeAccountId, stripeReaderId });
    if (locationId) await sdk.terminal.locations.del(locationId, {}, { stripeAccount: stripeAccountId });
  });

  test("the Payout Account can be read", async () => {
    const account = await retrievePayoutAccount(stripeAccountId);
    assert.ok(account, "retrievePayoutAccount returned nothing");
  });

  test("a registered Simulated Reader is listed under its Location", async () => {
    const readers = await listCardReaders({ stripeAccountId, locationId });
    assert.ok(readers.some((reader) => reader.stripeReaderId === stripeReaderId));
  });

  test("an approved card on the reader authorizes, gives card-present details, and captures", async () => {
    const attemptId = randomUUID();
    const { paymentIntentId } = await createCardReaderPaymentIntent({
      stripeAccountId,
      attemptId,
      amountCents: 1450,
      applicationFeeCents: 1,
      metadata: { contractTest: run },
    });
    await collectOnCardReader({ stripeAccountId, stripeReaderId, paymentIntentId, attemptId });
    await presentTestCard({ stripeAccountId, stripeReaderId, card: "APPROVED" });

    const authorized = await waitForStatus(paymentIntentId, ["requires_capture"]);
    assert.equal(authorized.amountCents, 1450);
    const details = await retrieveCardReaderPaymentDetails({ stripeAccountId, paymentIntentId });
    assert.equal(details?.type, "card_present");
    assert.equal(details.last4, "4242");

    await captureCardReaderPayment({ stripeAccountId, paymentIntentId });
    await waitForStatus(paymentIntentId, ["succeeded"]);
  });

  test("a declined card leaves the PaymentIntent with Stripe's reason, and it can be stopped and cancelled", async () => {
    const attemptId = randomUUID();
    const { paymentIntentId } = await createCardReaderPaymentIntent({
      stripeAccountId,
      attemptId,
      amountCents: 900,
      applicationFeeCents: 0,
      metadata: { contractTest: run },
    });
    await collectOnCardReader({ stripeAccountId, stripeReaderId, paymentIntentId, attemptId });
    await presentTestCard({ stripeAccountId, stripeReaderId, card: "DECLINED" });

    const declined = await waitForStatus(paymentIntentId, ["requires_payment_method"]);
    assert.ok(declined.lastPaymentError, "a decline carries last_payment_error");

    await stopCollectingOnCardReader({ stripeAccountId, stripeReaderId, paymentIntentId });
    await cancelCardReaderPaymentIntent({ stripeAccountId, paymentIntentId });
    await waitForStatus(paymentIntentId, ["canceled"]);
  });

  test("a reader collecting can be stopped, and its PaymentIntent cancelled twice", async () => {
    const attemptId = randomUUID();
    const { paymentIntentId } = await createCardReaderPaymentIntent({
      stripeAccountId,
      attemptId,
      amountCents: 500,
      applicationFeeCents: 0,
      metadata: { contractTest: run },
    });
    await collectOnCardReader({ stripeAccountId, stripeReaderId, paymentIntentId, attemptId });
    await stopCollectingOnCardReader({ stripeAccountId, stripeReaderId, paymentIntentId });
    await cancelCardReaderPaymentIntent({ stripeAccountId, paymentIntentId });
    await cancelCardReaderPaymentIntent({ stripeAccountId, paymentIntentId });
    await waitForStatus(paymentIntentId, ["canceled"]);
  });

  test("an online payment Checkout Session is made, read back and expired", async () => {
    const { checkoutSessionId, url } = await createOnlinePaymentCheckout({
      stripeAccountId,
      attemptId: randomUUID(),
      lines: [
        { quantity: 2, unitPriceCents: 450, title: "Espresso" },
        { quantity: 1, unitPriceCents: 550, title: "Kuchen" },
      ],
      amountCents: 1450,
      applicationFeeCents: 1,
      expiresAt: new Date(Date.now() + 31 * 60 * 1000),
      successUrl: "https://example.com/paid",
      cancelUrl: "https://example.com/back",
      metadata: { contractTest: run },
    });
    assert.ok(url);
    const checkout = await retrieveOnlinePaymentCheckout({ stripeAccountId, checkoutSessionId });
    assert.equal(checkout.amount_total, 1450);
    assert.equal(await expireOnlinePaymentCheckout({ stripeAccountId, checkoutSessionId }), "expired");
  });
});
