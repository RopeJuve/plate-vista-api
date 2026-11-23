// Runs our webhook parsing (src/modules/payouts/stripe.js) through the real
// stripe SDK, offline: signatures are made with the SDK's own test helper, so
// no key or network is needed. test/support/fakeStripe.js only imitates what
// the SDK refuses; this is where the imitation is checked.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import {
  constructWebhookEvent,
  parseAccountEventNotification,
  setStripeClient,
} from "../../src/modules/payouts/stripe.js";

const SECRETS = { STRIPE_WEBHOOK_SECRET: "whsec_snapshot", STRIPE_ACCOUNT_WEBHOOK_SECRET: "whsec_thin" };
const sdk = new Stripe("sk_test_offline");
const saved = {};

const signed = (payload, secret) => {
  const body = JSON.stringify(payload);
  return [Buffer.from(body), sdk.webhooks.generateTestHeaderString({ payload: body, secret })];
};
const snapshotEvent = { id: "evt_1", object: "event", type: "payment_intent.amount_capturable_updated", data: { object: {} } };
const thinEvent = {
  id: "evt_test_1",
  object: "v2.core.event",
  type: "v2.core.account[requirements].updated",
  related_object: { id: "acct_1", type: "v2.core.account", url: "/v2/core/accounts/acct_1" },
};

before(() => {
  for (const [name, value] of Object.entries(SECRETS)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  setStripeClient(sdk);
});

after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setStripeClient(null);
});

test("each route takes its own payload style", () => {
  assert.equal(constructWebhookEvent(...signed(snapshotEvent, SECRETS.STRIPE_WEBHOOK_SECRET)).id, "evt_1");
  assert.equal(parseAccountEventNotification(...signed(thinEvent, SECRETS.STRIPE_ACCOUNT_WEBHOOK_SECRET)).id, "evt_test_1");
});

test("a correctly signed event of the other payload style is STRIPE_WEBHOOK_WRONG_PAYLOAD", () => {
  assert.throws(() => constructWebhookEvent(...signed(thinEvent, SECRETS.STRIPE_WEBHOOK_SECRET)), {
    code: "STRIPE_WEBHOOK_WRONG_PAYLOAD",
  });
  assert.throws(() => parseAccountEventNotification(...signed(snapshotEvent, SECRETS.STRIPE_ACCOUNT_WEBHOOK_SECRET)), {
    code: "STRIPE_WEBHOOK_WRONG_PAYLOAD",
  });
});

test("another destination's secret is STRIPE_SIGNATURE_INVALID", () => {
  assert.throws(() => constructWebhookEvent(...signed(snapshotEvent, SECRETS.STRIPE_ACCOUNT_WEBHOOK_SECRET)), {
    code: "STRIPE_SIGNATURE_INVALID",
  });
  assert.throws(() => parseAccountEventNotification(...signed(thinEvent, SECRETS.STRIPE_WEBHOOK_SECRET)), {
    code: "STRIPE_SIGNATURE_INVALID",
  });
});
