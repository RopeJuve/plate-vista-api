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
import { createFakeStripe } from "../support/fakeStripe.js";

const WEBHOOK_SECRET = "whsec_test_payouts";
const STRIPE_ENV = {
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
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

const accountUpdated = (account, id = `evt_${randomUUID()}`) => ({
  id,
  object: "event",
  type: "account.updated",
  data: { object: account },
});

const deliver = (event, { secret = WEBHOOK_SECRET } = {}) => {
  const { body, signature } = fake.signedEvent(event, secret);
  return request(app)
    .post("/api/v1/webhooks/stripe")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", signature)
    .send(body);
};


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
  ]) {
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.code, "STRIPE_NOT_CONFIGURED");
  }
});

test("the owner gets an onboarding link for a new Express Payout Account in Germany", async () => {
  const { restaurant, asOwner } = await place();

  const res = await asOwner("post");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body), ["url"]);
  assert.match(res.body.url, /^https:\/\/connect\.stripe\.test\//);

  const [create] = fake.calls.filter(([op]) => op === "accounts.create");
  assert.equal(create[1].type, "express");
  assert.equal(create[1].country, "DE");
  assert.deepEqual(create[1].capabilities, {
    card_payments: { requested: true },
    transfers: { requested: true },
  });

  const stored = await Restaurant.findById(restaurant._id).lean();
  const accountId = stored.payoutAccount.stripeAccountId;
  assert.match(accountId, /^acct_/);
  assert.equal(stored.payoutAccount.chargesEnabled, false);
  assert.equal(stored.payoutAccount.detailsSubmitted, false);

  const [link] = fake.calls.filter(([op]) => op === "accountLinks.create");
  assert.deepEqual(link[1], {
    account: accountId,
    type: "account_onboarding",
    refresh_url: "https://dashboard.example.com/settings/payout-account",
    return_url: "https://dashboard.example.com/settings/payout-account",
  });
});

test("a second POST reuses the Payout Account and returns a fresh link", async () => {
  const { restaurant, asOwner } = await place();
  const first = await asOwner("post");
  const second = await asOwner("post");
  assert.equal(second.status, 200);
  assert.notEqual(second.body.url, first.body.url);
  assert.equal(fake.accountsCreated(), 1);

  const stored = await Restaurant.findById(restaurant._id).lean();
  const links = fake.calls.filter(([op]) => op === "accountLinks.create");
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
  assert.deepEqual(res.body, { connected: false, chargesEnabled: false, detailsSubmitted: false });
});

test("account.updated copies the Payout Account's flags, and a second delivery changes nothing", async () => {
  const { restaurant, asOwner } = await place();
  await asOwner("post");
  const accountId = (await Restaurant.findById(restaurant._id).lean()).payoutAccount.stripeAccountId;

  assert.deepEqual((await asOwner("get")).body, { connected: true, chargesEnabled: false, detailsSubmitted: false });

  fake.updateAccount(accountId, { charges_enabled: true, details_submitted: true });
  const event = accountUpdated({ id: accountId, object: "account", charges_enabled: true, details_submitted: true });

  const once = await deliver(event);
  assert.equal(once.status, 200, JSON.stringify(once.body));
  assert.deepEqual((await asOwner("get")).body, { connected: true, chargesEnabled: true, detailsSubmitted: true });

  const twice = await deliver(event);
  assert.equal(twice.status, 200);
  const stored = await Restaurant.findById(restaurant._id).lean();
  assert.deepEqual(stored.payoutAccount, { stripeAccountId: accountId, chargesEnabled: true, detailsSubmitted: true });
});

test("a stale account.updated delivered late does not undo newer flags", async () => {
  const { restaurant, asOwner } = await place();
  await asOwner("post");
  const accountId = (await Restaurant.findById(restaurant._id).lean()).payoutAccount.stripeAccountId;
  fake.updateAccount(accountId, { charges_enabled: true, details_submitted: true });

  const stale = accountUpdated({ id: accountId, object: "account", charges_enabled: false, details_submitted: false });
  assert.equal((await deliver(stale)).status, 200);
  assert.deepEqual((await asOwner("get")).body, { connected: true, chargesEnabled: true, detailsSubmitted: true });
});

test("a webhook with a wrong or missing signature is refused with 400", async () => {
  const { restaurant, asOwner } = await place();
  await asOwner("post");
  const accountId = (await Restaurant.findById(restaurant._id).lean()).payoutAccount.stripeAccountId;
  fake.updateAccount(accountId, { charges_enabled: true, details_submitted: true });
  const event = accountUpdated({ id: accountId, object: "account", charges_enabled: true, details_submitted: true });

  const forged = await deliver(event, { secret: "whsec_someone_else" });
  assert.equal(forged.status, 400);

  const unsigned = await request(app)
    .post("/api/v1/webhooks/stripe")
    .set("Content-Type", "application/json")
    .send(JSON.stringify(event));
  assert.equal(unsigned.status, 400);

  assert.deepEqual((await asOwner("get")).body, { connected: true, chargesEnabled: false, detailsSubmitted: false });
});

test("account.updated for an unknown account and unknown event types are acknowledged", async () => {
  const unknownAccount = await deliver(
    accountUpdated({ id: "acct_nobody", object: "account", charges_enabled: true, details_submitted: true })
  );
  assert.equal(unknownAccount.status, 200);

  const unknownType = await deliver({ id: `evt_${randomUUID()}`, object: "event", type: "charge.refunded", data: { object: {} } });
  assert.equal(unknownType.status, 200);
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
