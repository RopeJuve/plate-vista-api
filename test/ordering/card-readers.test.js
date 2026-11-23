process.env.JWT_SECRET = "test-secret-card-readers";
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

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_card_readers",
  DASHBOARD_URL: "https://dashboard.example.com",
};

const LEGAL = {
  legalName: "Trattoria Beispiel GmbH",
  address: { street: "Hauptstraße 1", zip: "10115", city: "Berlin", country: "DE" },
  taxNumber: "12/345/67890",
};

const READER_KEYS = ["id", "name", "deviceType", "serialNumber", "status", "simulated", "busyWith", "addedAt"];

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

// A restaurant whose Payout Account can take charges and whose legal address
// is filled in, unless told otherwise.
const place = async ({ chargesEnabled = true, payoutAccount = true, legal = LEGAL } = {}) => {
  const suffix = randomUUID().slice(0, 8);
  const stripeAccountId = `acct_${suffix}`;
  const restaurant = await Restaurant.create({
    name: `R${suffix}`,
    slug: `r-${suffix}`,
    ...(legal ? { legal } : {}),
    ...(payoutAccount ? { payoutAccount: { stripeAccountId, chargesEnabled, detailsSubmitted: chargesEnabled } } : {}),
  });
  const as = (token) => (method, path = "") =>
    request(app)[method](`/api/v1/restaurant/card-readers${path}`).set("Authorization", `Bearer ${token}`);
  const guestToken = generateTableToken({
    restaurantId: restaurant._id,
    tableId: randomUUID(),
    sessionId: randomUUID(),
  });
  return {
    restaurant,
    stripeAccountId,
    asOwner: as(generateToken(await staffOf(restaurant, "owner"))),
    asAdmin: as(generateToken(await staffOf(restaurant, "admin"))),
    asBar: as(generateToken(await staffOf(restaurant, "bar"))),
    asKitchen: as(generateToken(await staffOf(restaurant, "kitchen"))),
    asGuest: as(guestToken),
  };
};

const callsOf = (op) => fake.calls.filter(([name]) => name === op);

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

test("without Stripe keys every card reader route answers 503 STRIPE_NOT_CONFIGURED", async () => {
  setStripeClient(null);
  delete process.env.STRIPE_SECRET_KEY;
  const { asOwner } = await place();

  for (const res of [
    await asOwner("get"),
    await asOwner("post").send({ registrationCode: "a-b-c", name: "Bar" }),
    await asOwner("post", "/simulated").send({ name: "Test" }),
    await asOwner("delete", "/6650c0ffee0000000000a001"),
  ]) {
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.code, "STRIPE_NOT_CONFIGURED");
  }
});

test("staff without the admin role and guests are refused on every endpoint", async () => {
  const { asOwner, asBar, asKitchen, asGuest } = await place();
  const added = await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Bar" });
  assert.equal(added.status, 201, JSON.stringify(added.body));

  for (const as of [asBar, asKitchen, asGuest]) {
    for (const res of [
      await as("get"),
      await as("post").send({ registrationCode: fake.pairingCode(), name: "Bar" }),
      await as("post", "/simulated").send({ name: "Test" }),
      await as("delete", `/${added.body.id}`),
    ]) {
      assert.equal(res.status, 403, JSON.stringify(res.body));
    }
  }
  assert.equal(callsOf("terminal.readers.create").length, 1);
  assert.equal(callsOf("terminal.readers.del").length, 0);
});

test("the owner adds a reader by registration code and name; it is registered on the Payout Account under its Terminal Location", async () => {
  const { stripeAccountId, asOwner } = await place();
  const code = fake.pairingCode({ deviceType: "stripe_s700", serialNumber: "STRM26138003393" });

  const res = await asOwner("post").send({ registrationCode: code, name: "  Bar  " });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body), READER_KEYS);
  assert.match(res.body.id, /^[a-f0-9]{24}$/);
  assert.equal(res.body.name, "Bar");
  assert.equal(res.body.deviceType, "stripe_s700");
  assert.equal(res.body.serialNumber, "STRM26138003393");
  assert.equal(res.body.status, "online");
  assert.equal(res.body.simulated, false);
  assert.equal(res.body.busyWith, null);
  assert.ok(!Number.isNaN(Date.parse(res.body.addedAt)));

  const [location] = fake.locationsOn(stripeAccountId);
  assert.deepEqual(location.address, { line1: "Hauptstraße 1", postal_code: "10115", city: "Berlin", country: "DE" });
  assert.equal(location.display_name, "Trattoria Beispiel GmbH");
  const [reader] = fake.readersOn(stripeAccountId);
  assert.equal(reader.location, location.id);
  assert.equal(reader.label, "Bar");
  // Our id, not Stripe's.
  assert.notEqual(res.body.id, reader.id);
});

test("an admin can add a reader too", async () => {
  const { asAdmin } = await place();
  const res = await asAdmin("post").send({ registrationCode: fake.pairingCode(), name: "Terrasse" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test("the Terminal Location is created once per restaurant, on the first reader", async () => {
  const { stripeAccountId, asOwner } = await place();
  const other = await place();

  for (const name of ["Bar", "Terrasse"]) {
    const res = await asOwner("post").send({ registrationCode: fake.pairingCode(), name });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const simulated = await asOwner("post", "/simulated").send({ name: "Test" });
  assert.equal(simulated.status, 201, JSON.stringify(simulated.body));
  assert.equal((await other.asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Bar" })).status, 201);

  const [location] = fake.locationsOn(stripeAccountId);
  assert.equal(fake.locationsOn(stripeAccountId).length, 1);
  assert.equal(fake.locationsOn(other.stripeAccountId).length, 1);
  assert.deepEqual(new Set(fake.readersOn(stripeAccountId).map((reader) => reader.location)), new Set([location.id]));
});

test("adding is refused with PAYOUT_ACCOUNT_NOT_READY while the Payout Account can't take charges", async () => {
  for (const { asOwner } of [await place({ chargesEnabled: false }), await place({ payoutAccount: false })]) {
    for (const res of [
      await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Bar" }),
      await asOwner("post", "/simulated").send({ name: "Test" }),
    ]) {
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.deepEqual(res.body, {
        code: "PAYOUT_ACCOUNT_NOT_READY",
        message: "The Payout Account cannot take payments yet.",
      });
    }
  }
  assert.equal(callsOf("terminal.locations.create").length, 0);
  assert.equal(callsOf("terminal.readers.create").length, 0);
});

test("without a legal address the first reader is refused with RESTAURANT_DETAILS_MISSING", async () => {
  const { asOwner } = await place({ legal: null });
  for (const res of [
    await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Bar" }),
    await asOwner("post", "/simulated").send({ name: "Test" }),
  ]) {
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.code, "RESTAURANT_DETAILS_MISSING");
  }
  assert.equal(callsOf("terminal.locations.create").length, 0);
});

test("an invalid or already used registration code answers 422 CARD_READER_CODE_INVALID with Stripe's reason", async () => {
  const { asOwner } = await place();

  const invalid = await asOwner("post").send({ registrationCode: "nope-nope-nope", name: "Bar" });
  assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
  assert.equal(invalid.body.code, "CARD_READER_CODE_INVALID");
  assert.equal(invalid.body.message, "The registration code is invalid, expired or already used.");
  assert.match(invalid.body.details.reason, /invalid or has expired/);

  const code = fake.pairingCode();
  assert.equal((await asOwner("post").send({ registrationCode: code, name: "Bar" })).status, 201);
  const used = await asOwner("post").send({ registrationCode: code, name: "Bar again" });
  assert.equal(used.status, 422, JSON.stringify(used.body));
  assert.equal(used.body.code, "CARD_READER_CODE_INVALID");
  assert.match(used.body.details.reason, /already registered/);

  const list = await asOwner("get");
  assert.equal(list.body.items.length, 1);
});

test("other Stripe failures while adding answer 502 PAYMENT_PROVIDER_ERROR and keep nothing", async () => {
  const { asOwner } = await place();

  fake.failNext("terminal.locations.create");
  const location = await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Bar" });
  assert.equal(location.status, 502, JSON.stringify(location.body));
  assert.equal(location.body.code, "PAYMENT_PROVIDER_ERROR");

  fake.failNext("terminal.readers.create");
  const reader = await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Bar" });
  assert.equal(reader.status, 502, JSON.stringify(reader.body));
  assert.equal(reader.body.code, "PAYMENT_PROVIDER_ERROR");

  assert.deepEqual((await asOwner("get")).body.items, []);
});

test("name and registration code are validated", async () => {
  const { asOwner } = await place();
  for (const res of [
    await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "   " }),
    await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "x".repeat(41) }),
    await asOwner("post").send({ name: "Bar" }),
    await asOwner("post").send({ registrationCode: "  ", name: "Bar" }),
    await asOwner("post", "/simulated").send({}),
    await asOwner("post", "/simulated").send({ name: 5 }),
  ]) {
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, "VALIDATION");
  }
  assert.equal(callsOf("terminal.readers.create").length, 0);
  const ok = await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "x".repeat(40) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("in test mode a Simulated Reader can be added", async () => {
  const { stripeAccountId, asOwner } = await place();

  const res = await asOwner("post", "/simulated").send({ name: "Test reader" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body), READER_KEYS);
  assert.equal(res.body.name, "Test reader");
  assert.equal(res.body.simulated, true);
  assert.equal(res.body.status, "online");
  assert.equal(res.body.deviceType, "simulated_wisepos_e");
  const [reader] = fake.readersOn(stripeAccountId);
  assert.equal(reader.device_type, "simulated_wisepos_e");
});

test("in live mode a Simulated Reader is refused with SIMULATED_READER_LIVE_MODE", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_live_card_readers";
  const { asOwner } = await place();

  const res = await asOwner("post", "/simulated").send({ name: "Test reader" });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.deepEqual(res.body, {
    code: "SIMULATED_READER_LIVE_MODE",
    message: "Simulated readers exist only in test mode.",
  });
  assert.equal(callsOf("terminal.readers.create").length, 0);
  assert.equal((await asOwner("get")).body.testMode, false);
});

test("the list returns each reader's name, type, simulated flag and Stripe's online/offline status, by name", async () => {
  const { stripeAccountId, asOwner, asAdmin } = await place();
  const terrasse = await asOwner("post").send({
    registrationCode: fake.pairingCode({ deviceType: "bbpos_wisepos_e", serialNumber: "WSC513105011295" }),
    name: "Terrasse",
  });
  await asOwner("post").send({
    registrationCode: fake.pairingCode({ deviceType: "stripe_s700", serialNumber: "STRM26138003393" }),
    name: "Bar",
  });
  await asOwner("post", "/simulated").send({ name: "Test reader" });
  const terrasseAtStripe = fake.readersOn(stripeAccountId).find((reader) => reader.label === "Terrasse");
  fake.setReaderStatus(terrasseAtStripe.id, "offline");

  const res = await asAdmin("get");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body), ["items", "testMode", "payoutAccountReady"]);
  assert.equal(res.body.testMode, true);
  assert.equal(res.body.payoutAccountReady, true);
  assert.deepEqual(
    res.body.items.map(({ name, deviceType, serialNumber, status, simulated, busyWith }) => ({
      name, deviceType, serialNumber, status, simulated, busyWith,
    })),
    [
      { name: "Bar", deviceType: "stripe_s700", serialNumber: "STRM26138003393", status: "online", simulated: false, busyWith: null },
      { name: "Terrasse", deviceType: "bbpos_wisepos_e", serialNumber: "WSC513105011295", status: "offline", simulated: false, busyWith: null },
      { name: "Test reader", deviceType: "simulated_wisepos_e", serialNumber: res.body.items[2].serialNumber, status: "online", simulated: true, busyWith: null },
    ]
  );
  for (const item of res.body.items) assert.deepEqual(Object.keys(item), READER_KEYS);
  assert.equal(res.body.items[1].id, terrasse.body.id);
});

test("the list shows the stored status when Stripe cannot be read", async () => {
  const { asOwner } = await place();
  await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Bar" });

  fake.failNext("terminal.readers.list");
  const res = await asOwner("get");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].status, "online");
});

test("before the Payout Account can take charges the list is empty and payoutAccountReady is false", async () => {
  const { asAdmin } = await place({ chargesEnabled: false });
  const res = await asAdmin("get");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { items: [], testMode: true, payoutAccountReady: false });
});

test("readers are tenant-scoped: another restaurant neither sees nor removes them", async () => {
  const mine = await place();
  const theirs = await place();
  const added = await mine.asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Bar" });

  assert.deepEqual((await theirs.asOwner("get")).body.items, []);
  const res = await theirs.asOwner("delete", `/${added.body.id}`);
  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.equal(fake.readersOn(mine.stripeAccountId).length, 1);
});

test("removing a reader deletes it at Stripe and in Plate Vista", async () => {
  const { stripeAccountId, asOwner, asAdmin } = await place();
  const bar = await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Bar" });
  await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Terrasse" });

  const res = await asAdmin("delete", `/${bar.body.id}`);
  assert.equal(res.status, 204, JSON.stringify(res.body));
  assert.equal(res.text, "");
  assert.deepEqual(fake.readersOn(stripeAccountId).map((reader) => reader.label), ["Terrasse"]);
  assert.deepEqual((await asOwner("get")).body.items.map((item) => item.name), ["Terrasse"]);

  const again = await asAdmin("delete", `/${bar.body.id}`);
  assert.equal(again.status, 404, JSON.stringify(again.body));
  assert.equal((await asAdmin("delete", "/not-an-id")).status, 404);
});

test("a reader already gone at Stripe is still removed in Plate Vista", async () => {
  const { stripeAccountId, asOwner } = await place();
  const bar = await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Bar" });
  const [atStripe] = fake.readersOn(stripeAccountId);
  await fake.terminal.readers.del(atStripe.id, {}, { stripeAccount: stripeAccountId });

  const res = await asOwner("delete", `/${bar.body.id}`);
  assert.equal(res.status, 204, JSON.stringify(res.body));
  assert.deepEqual((await asOwner("get")).body.items, []);
});

test("when Stripe fails to remove a reader it answers 502 PAYMENT_PROVIDER_ERROR and the reader stays", async () => {
  const { stripeAccountId, asOwner } = await place();
  const bar = await asOwner("post").send({ registrationCode: fake.pairingCode(), name: "Bar" });

  fake.failNext("terminal.readers.del");
  const res = await asOwner("delete", `/${bar.body.id}`);
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.code, "PAYMENT_PROVIDER_ERROR");
  assert.equal(fake.readersOn(stripeAccountId).length, 1);
  assert.equal((await asOwner("get")).body.items.length, 1);
});
