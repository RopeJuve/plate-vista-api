process.env.JWT_SECRET = "test-secret-payout-account";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateTableToken, generateToken, hashPassword } from "../../src/shared/auth.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import { setStripeClient } from "../../src/modules/payouts/stripe.js";
import { accountState, createFakeStripe } from "../support/fakeStripe.js";

const WEBHOOK_SECRET = "whsec_test_payouts";
const ACCOUNT_WEBHOOK_SECRET = "whsec_test_payout_account_events";
const STRIPE_ENV = {
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_ACCOUNT_WEBHOOK_SECRET: ACCOUNT_WEBHOOK_SECRET,
  DASHBOARD_URL: "https://dashboard.example.com",
  GUEST_APP_URL: "https://guest.example.com",
};

let mongod;
let app;
let request;
let passwordHash;
let fake;

const staffOf = (restaurant, position) =>
  Employee.create({
    restaurantId: restaurant._id,
    employee: `${position}-${randomUUID().slice(0, 8)}`,
    email: `${position}-${randomUUID().slice(0, 8)}@example.com`,
    password: passwordHash,
    position,
    role: position === "bar" ? "staff" : position,
  });

const place = async () => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({ name: `R${suffix}`, slug: `r-${suffix}` });
  const as = (token) => (method) =>
    request(app)[method]("/api/v1/restaurant/payout-account").set("Authorization", `Bearer ${token}`);
  const guestToken = generateTableToken({
    restaurantId: restaurant._id,
    tableId: randomUUID(),
    sessionId: randomUUID(),
  });
  return {
    restaurant,
    asOwner: as(generateToken(await staffOf(restaurant, "owner"))),
    asAdmin: as(generateToken(await staffOf(restaurant, "admin"))),
    asBar: as(generateToken(await staffOf(restaurant, "bar"))),
    asKitchen: as(generateToken(await staffOf(restaurant, "kitchen"))),
    asGuest: as(guestToken),
  };
};

// A thin event notification, as an Accounts v2 event destination sends it.
const accountEvent = (stripeAccountId, type = "v2.core.account[requirements].updated", id = `evt_${randomUUID()}`) => ({
  id,
  object: "v2.core.event",
  type,
  livemode: false,
  created: new Date().toISOString(),
  context: null,
  related_object: { id: stripeAccountId, type: "v2.core.account", url: `/v2/core/accounts/${stripeAccountId}` },
});

const post = (path, event, secret) => {
  const { body, signature } = fake.signedEvent(event, secret);
  return request(app)
    .post(path)
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", signature)
    .send(body);
};

const deliver = (event, { secret = WEBHOOK_SECRET } = {}) => post("/api/v1/webhooks/stripe", event, secret);
const deliverAccountEvent = (event, { secret = ACCOUNT_WEBHOOK_SECRET } = {}) =>
  post("/api/v1/webhooks/stripe/accounts", event, secret);

const storedAccount = async (restaurant) => (await Restaurant.findById(restaurant._id).lean()).payoutAccount;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_DB_URL = mongod.getUri();
  await connectToDatabase();
  ({ default: request } = await import("supertest"));
  ({ default: app } = await import("../../src/app.js"));
  passwordHash = await hashPassword("supersecret1");
}, { timeout: 120000 });

test.beforeEach(() => {
  Object.assign(process.env, STRIPE_ENV);
  fake = createFakeStripe();
  setStripeClient(fake);
});

test.afterEach(() => {
  for (const name of Object.keys(STRIPE_ENV)) delete process.env[name];
  setStripeClient(null);
});

test.after(async () => {
  await disconnectDatabase();
  await mongod?.stop();
});

test("without Stripe settings the Payout Account routes and the webhook answer 503 STRIPE_NOT_CONFIGURED", async () => {
  setStripeClient(null);
  for (const name of Object.keys(STRIPE_ENV)) delete process.env[name];
  delete process.env.STRIPE_SECRET_KEY;
  const { asOwner } = await place();

  for (const res of [
    await asOwner("post"),
    await asOwner("get"),
    await request(app).post("/api/v1/webhooks/stripe").set("Content-Type", "application/json").send("{}"),
    await request(app).post("/api/v1/webhooks/stripe/accounts").set("Content-Type", "application/json").send("{}"),
  ]) {
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.code, "STRIPE_NOT_CONFIGURED");
  }
});

test("the owner gets an onboarding link for a new Accounts v2 Payout Account in Germany where Stripe carries losses", async () => {
  const { restaurant, asOwner } = await place();

  const res = await asOwner("post");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body), ["url"]);
  assert.match(res.body.url, /^https:\/\/connect\.stripe\.test\//);

  const [create] = fake.calls.filter(([op]) => op === "v2.core.accounts.create");
  const [, params, options] = create;
  // No legacy account `type`: Stripe refuses it when the platform would carry losses.
  assert.equal("type" in params, false);
  assert.equal(params.dashboard, "full");
  assert.deepEqual(params.identity, { country: "de" });
  assert.deepEqual(params.configuration, { merchant: { capabilities: { card_payments: { requested: true } } } });
  assert.deepEqual(params.defaults, {
    currency: "eur",
    responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
  });
  assert.deepEqual(params.metadata, { restaurantId: String(restaurant._id) });
  assert.deepEqual(params.include, ["configuration.merchant", "requirements"]);
  assert.equal(options.idempotencyKey, `payout-account-v2-${restaurant._id}`);

  const stored = await storedAccount(restaurant);
  const accountId = stored.stripeAccountId;
  assert.match(accountId, /^acct_/);
  assert.equal(stored.chargesEnabled, false);
  assert.equal(stored.detailsSubmitted, false);

  const [link] = fake.calls.filter(([op]) => op === "v2.core.accountLinks.create");
  assert.deepEqual(link[1], {
    account: accountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        collection_options: { fields: "eventually_due" },
        refresh_url: "https://dashboard.example.com/admin/kasse?payout=refresh",
        return_url: "https://dashboard.example.com/admin/kasse?payout=return",
      },
    },
  });
});

test("onboarding returns the owner to the Kasse page even when DASHBOARD_URL ends in a slash", async () => {
  process.env.DASHBOARD_URL = "https://dashboard.example.com/";
  const { asOwner } = await place();

  const res = await asOwner("post");
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const [link] = fake.calls.filter(([op]) => op === "v2.core.accountLinks.create");
  const { refresh_url, return_url } = link[1].use_case.account_onboarding;
  assert.equal(refresh_url, "https://dashboard.example.com/admin/kasse?payout=refresh");
  assert.equal(return_url, "https://dashboard.example.com/admin/kasse?payout=return");
});

test("a second POST reuses the Payout Account and returns a fresh link", async () => {
  const { restaurant, asOwner } = await place();
  const first = await asOwner("post");
  const second = await asOwner("post");
  assert.equal(second.status, 200);
  assert.notEqual(second.body.url, first.body.url);
  assert.equal(fake.accountsCreated(), 1);

  const stored = await Restaurant.findById(restaurant._id).lean();
  const links = fake.calls.filter(([op]) => op === "v2.core.accountLinks.create");
  assert.deepEqual(links.map(([, params]) => params.account), [
    stored.payoutAccount.stripeAccountId,
    stored.payoutAccount.stripeAccountId,
  ]);
});

test("only the owner may set up or read the Payout Account", async () => {
  const { asAdmin, asBar, asKitchen, asGuest } = await place();
  for (const as of [asAdmin, asBar, asKitchen, asGuest]) {
    assert.equal((await as("post")).status, 403);
    assert.equal((await as("get")).status, 403);
  }
  assert.equal(fake.accountsCreated(), 0);
  assert.equal((await request(app).get("/api/v1/restaurant/payout-account")).status, 401);
});

test("a restaurant without a Payout Account reads as not connected", async () => {
  const { asOwner } = await place();
  const res = await asOwner("get");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { connected: false, chargesEnabled: false, detailsSubmitted: false, onlinePaymentsEnabled: true });
});

test("reading the Payout Account asks Stripe until it can take payments: unfinished, under review, ready", async () => {
  const { restaurant, asOwner } = await place();
  await asOwner("post");
  const accountId = (await storedAccount(restaurant)).stripeAccountId;
  const read = async () => (await asOwner("get")).body;
  const retrieves = () => fake.calls.filter(([op]) => op === "v2.core.accounts.retrieve").length;

  assert.deepEqual(await read(), { connected: true, chargesEnabled: false, detailsSubmitted: false, onlinePaymentsEnabled: true });

  fake.updateAccount(accountId, accountState({ cardPayments: "pending", ownerDue: false }));
  assert.deepEqual(await read(), { connected: true, chargesEnabled: false, detailsSubmitted: true, onlinePaymentsEnabled: true });

  fake.updateAccount(accountId, accountState({ cardPayments: "active", ownerDue: false }));
  assert.deepEqual(await read(), { connected: true, chargesEnabled: true, detailsSubmitted: true, onlinePaymentsEnabled: true });
  const [, , params] = fake.calls.findLast(([op]) => op === "v2.core.accounts.retrieve");
  assert.deepEqual(params, { include: ["configuration.merchant", "requirements"] });

  // Ready: later changes come by event, so reads stop asking Stripe.
  const before = retrieves();
  await read();
  assert.equal(retrieves(), before);
});

test("when Stripe cannot be read, the owner sees the stored status", async () => {
  const { restaurant, asOwner } = await place();
  await Restaurant.updateOne(
    { _id: restaurant._id },
    { $set: { payoutAccount: { stripeAccountId: "acct_gone", chargesEnabled: false, detailsSubmitted: true } } }
  );
  const res = await asOwner("get");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { connected: true, chargesEnabled: false, detailsSubmitted: true, onlinePaymentsEnabled: true });
});

test("an account event stores the Payout Account's state as Stripe has it, and a second delivery changes nothing", async () => {
  const { restaurant, asOwner } = await place();
  await asOwner("post");
  const accountId = (await storedAccount(restaurant)).stripeAccountId;
  fake.updateAccount(accountId, accountState({ cardPayments: "active", ownerDue: false }));
  const event = accountEvent(accountId, "v2.core.account[configuration.merchant].capability_status_updated");

  const once = await deliverAccountEvent(event);
  assert.equal(once.status, 200, JSON.stringify(once.body));
  assert.deepEqual(await storedAccount(restaurant), {
    stripeAccountId: accountId,
    chargesEnabled: true,
    detailsSubmitted: true,
    onlinePaymentsEnabled: true,
  });

  const twice = await deliverAccountEvent(event);
  assert.equal(twice.status, 200);
  assert.deepEqual(await storedAccount(restaurant), {
    stripeAccountId: accountId,
    chargesEnabled: true,
    detailsSubmitted: true,
    onlinePaymentsEnabled: true,
  });

  // A capability Stripe restricts later turns online payments off again.
  fake.updateAccount(accountId, accountState({ cardPayments: "restricted", ownerDue: true }));
  await deliverAccountEvent(accountEvent(accountId));
  const restricted = await storedAccount(restaurant);
  assert.equal(restricted.chargesEnabled, false);
  assert.equal(restricted.detailsSubmitted, false);
});

test("an account event with a wrong or missing signature is refused with 400", async () => {
  const { restaurant, asOwner } = await place();
  await asOwner("post");
  const accountId = (await storedAccount(restaurant)).stripeAccountId;
  fake.updateAccount(accountId, accountState({ cardPayments: "active", ownerDue: false }));
  const event = accountEvent(accountId);

  // The other destination's secret does not sign account events.
  assert.equal((await deliverAccountEvent(event, { secret: WEBHOOK_SECRET })).status, 400);
  const unsigned = await request(app)
    .post("/api/v1/webhooks/stripe/accounts")
    .set("Content-Type", "application/json")
    .send(JSON.stringify(event));
  assert.equal(unsigned.status, 400);

  const stored = await storedAccount(restaurant);
  assert.equal(stored.chargesEnabled, false);
});

// A destination with the wrong payload style for its route: the setup is
// wrong, so say which way round it should be, signed or not.
test("a thin event on the snapshot route, or a snapshot event on the accounts route, is refused with 400 STRIPE_WEBHOOK_WRONG_PAYLOAD", async () => {
  const thinOnSnapshotRoute = await deliver(accountEvent("acct_nobody", "v1.payment_intent.amount_capturable_updated"));
  assert.equal(thinOnSnapshotRoute.status, 400);
  assert.equal(thinOnSnapshotRoute.body.code, "STRIPE_WEBHOOK_WRONG_PAYLOAD");
  assert.match(thinOnSnapshotRoute.body.message, /snapshot/);

  const snapshotOnAccountsRoute = await deliverAccountEvent({
    id: `evt_${randomUUID()}`,
    object: "event",
    type: "payment_intent.amount_capturable_updated",
    data: { object: {} },
  });
  assert.equal(snapshotOnAccountsRoute.status, 400);
  assert.equal(snapshotOnAccountsRoute.body.code, "STRIPE_WEBHOOK_WRONG_PAYLOAD");
  assert.match(snapshotOnAccountsRoute.body.message, /thin/);
});

test("account events for an unknown account or other objects, and unknown snapshot events, are acknowledged", async () => {
  const unknownAccount = await deliverAccountEvent(accountEvent("acct_nobody"));
  assert.equal(unknownAccount.status, 200);

  const otherObject = await deliverAccountEvent({
    ...accountEvent("acct_nobody", "v1.billing.meter.no_meter_found"),
    related_object: { id: "mtr_1", type: "billing.meter", url: "/v1/billing/meters/mtr_1" },
  });
  assert.equal(otherObject.status, 200);
  assert.equal(fake.calls.some(([op]) => op === "v2.core.accounts.retrieve"), false);

  const unknownType = await deliver({ id: `evt_${randomUUID()}`, object: "event", type: "charge.refunded", data: { object: {} } });
  assert.equal(unknownType.status, 200);

  const wrongSecret = await deliver({ id: `evt_${randomUUID()}`, object: "event", type: "charge.refunded", data: { object: {} } }, { secret: "whsec_someone_else" });
  assert.equal(wrongSecret.status, 400);
});

test("JSON bodies still parse on other routes, and guests never see the Stripe account id", async () => {
  const { restaurant, asOwner } = await place();
  await asOwner("post");
  const owner = await Employee.findOne({ restaurantId: restaurant._id, position: "owner" });
  const legal = {
    legalName: "Puzzle GmbH",
    address: { street: "Hauptstraße 1", zip: "10115", city: "Berlin", country: "DE" },
    taxNumber: "27/123/45678",
  };
  const saved = await request(app)
    .put("/api/v1/restaurant/legal")
    .set("Authorization", `Bearer ${generateToken(owner)}`)
    .send(legal);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.legalName, "Puzzle GmbH");

  const pub = await request(app).get(`/api/v1/r/${restaurant.slug}/profile`);
  assert.equal(pub.status, 200);
  assert.doesNotMatch(JSON.stringify(pub.body), /acct_|payout/i);
});
