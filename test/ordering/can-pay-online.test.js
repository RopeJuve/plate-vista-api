process.env.JWT_SECRET = "test-secret-can-pay-online";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateTableToken, generateToken, hashPassword } from "../../src/shared/auth.js";
import { cancelOrder, createOrder } from "../../src/modules/ordering/order.service.js";
import TableSession from "../../src/modules/ordering/session.model.js";
import Payment from "../../src/modules/payments/payment.model.js";
import { signing } from "../../src/modules/payments/signing.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";
import { setStripeClient } from "../../src/modules/payouts/stripe.js";
import { createFakeStripe } from "../support/fakeStripe.js";

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_can_pay_online",
  DASHBOARD_URL: "https://dashboard.example.com",
};

let replset;
let app;
let request;
let passwordHash;

const staffOf = (restaurant, position) =>
  Employee.create({
    restaurantId: restaurant._id,
    employee: `${position}-${randomUUID().slice(0, 8)}`,
    email: `${position}-${randomUUID().slice(0, 8)}@example.com`,
    password: passwordHash,
    position,
    role: position,
  });

// A restaurant where every condition for paying online holds, and one open
// session with an unpaid 10 € order on it. Each option breaks one condition.
const fixture = async ({
  chargesEnabled = true,
  onlinePaymentsEnabled,
  connected = true,
  tseActive = true,
} = {}) => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({
    name: `R${suffix}`,
    slug: `r-${suffix}`,
    ...(tseActive ? { tse: { setupStep: "DONE", tssSerial: "serial", clientId: "client" } } : {}),
    ...(connected
      ? {
          payoutAccount: {
            stripeAccountId: `acct_${suffix}`,
            chargesEnabled,
            detailsSubmitted: chargesEnabled,
            ...(onlinePaymentsEnabled === undefined ? {} : { onlinePaymentsEnabled }),
          },
        }
      : {}),
  });
  const owner = await staffOf(restaurant, "owner");
  const admin = await staffOf(restaurant, "admin");
  const waiter = await staffOf(restaurant, "waiter");
  const table = await Table.create({ restaurantId: restaurant._id, tableNumber: 1, capacity: 4 });
  const category = await Category.create({
    restaurantId: restaurant._id,
    name: "food",
    station: "kitchen",
    position: 1,
  });
  const item = await MenuItem.create({
    restaurantId: restaurant._id,
    title: "Pizza",
    priceCents: 1000,
    categoryId: category._id,
    inStock: true,
  });
  const ctx = {
    restaurantId: restaurant._id,
    requestId: randomUUID(),
    actor: { type: "employee", id: waiter._id, position: waiter.position },
  };
  const { order } = await createOrder(ctx, {
    clientOrderId: randomUUID(),
    tableId: String(table._id),
    items: [{ productId: String(item._id), quantity: 1 }],
  });
  const sessionId = order.sessionId;
  const guestToken = generateTableToken({ restaurantId: restaurant._id, tableId: table._id, sessionId });
  const bill = (token = guestToken) =>
    request(app).get(`/api/v1/sessions/${sessionId}/bill`).set("Authorization", `Bearer ${token}`);
  const payoutAccount = (token) => (method) =>
    request(app)[method]("/api/v1/restaurant/payout-account").set("Authorization", `Bearer ${token}`);
  return {
    restaurant,
    order,
    ctx,
    sessionId,
    bill,
    asGuest: () => bill(guestToken),
    waiterToken: generateToken(waiter),
    asWaiter: () => bill(generateToken(waiter)),
    payoutAccountAs: {
      owner: payoutAccount(generateToken(owner)),
      admin: payoutAccount(generateToken(admin)),
      waiter: payoutAccount(generateToken(waiter)),
      guest: payoutAccount(guestToken),
    },
  };
};

const canPayOnline = async (res) => {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(typeof res.body.canPayOnline, "boolean");
  return res.body.canPayOnline;
};

const realRequestSigning = signing.requestSigning;

test.before(async () => {
  signing.requestSigning = async () => {};
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_DB_URL = replset.getUri();
  await connectToDatabase();
  ({ default: request } = await import("supertest"));
  ({ default: app } = await import("../../src/app.js"));
  passwordHash = await hashPassword("supersecret1");
  await Payment.init();
}, { timeout: 180000 });

test.beforeEach(() => {
  Object.assign(process.env, STRIPE_ENV);
  setStripeClient(createFakeStripe());
});

test.afterEach(() => {
  for (const name of Object.keys(STRIPE_ENV)) delete process.env[name];
  setStripeClient(null);
});

test.after(async () => {
  signing.requestSigning = realRequestSigning;
  await disconnectDatabase();
  await replset?.stop();
});

test("a guest can pay online when every condition holds, and staff see the same", async () => {
  const place = await fixture();
  assert.equal(await canPayOnline(await place.asGuest()), true);
  assert.equal(await canPayOnline(await place.asWaiter()), true);
});

test("onlinePaymentsEnabled defaults to true", async () => {
  const place = await fixture();
  const stored = await Restaurant.findById(place.restaurant._id).lean();
  assert.equal(stored.payoutAccount.onlinePaymentsEnabled, true);
  const res = await place.payoutAccountAs.owner("get");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, {
    connected: true,
    chargesEnabled: true,
    detailsSubmitted: true,
    onlinePaymentsEnabled: true,
  });
});

test("no Payout Account, or one without chargesEnabled, turns canPayOnline false", async () => {
  assert.equal(await canPayOnline(await (await fixture({ connected: false })).asGuest()), false);
  assert.equal(await canPayOnline(await (await fixture({ chargesEnabled: false })).asGuest()), false);
});

test("online payments switched off turns canPayOnline false", async () => {
  const place = await fixture({ onlinePaymentsEnabled: false });
  assert.equal(await canPayOnline(await place.asGuest()), false);
  assert.equal(await canPayOnline(await place.asWaiter()), false);
});

test("an inactive TSE turns canPayOnline false", async () => {
  const place = await fixture({ tseActive: false });
  assert.equal(await canPayOnline(await place.asGuest()), false);
});

test("a session that is not open turns canPayOnline false", async () => {
  const paying = await fixture();
  await TableSession.updateOne({ _id: paying.sessionId, restaurantId: paying.restaurant._id }, { $set: { status: "paying" } });
  assert.equal(await canPayOnline(await paying.asWaiter()), false);

  const closed = await fixture();
  await TableSession.updateOne({ _id: closed.sessionId, restaurantId: closed.restaurant._id }, { $set: { status: "closed", closedAt: new Date() } });
  assert.equal(await canPayOnline(await closed.asWaiter()), false);
});

test("a paid bill turns canPayOnline false", async () => {
  const place = await fixture();
  const res = await request(app)
    .post(`/api/v1/sessions/${place.sessionId}/payments`)
    .set("Authorization", `Bearer ${place.waiterToken}`)
    .send({ method: "CASH", clientPaymentId: randomUUID(), expectedTotalCents: 1000 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(await canPayOnline(await place.asWaiter()), false);
});

test("an empty bill turns canPayOnline false", async () => {
  const place = await fixture();
  await cancelOrder(place.ctx, { orderId: place.order._id, reason: "no" });
  const res = await place.asGuest();
  assert.equal(res.body.totalCents, 0);
  assert.equal(await canPayOnline(res), false);
});

test("without STRIPE_SECRET_KEY canPayOnline is false and the bill still loads", async () => {
  const place = await fixture();
  delete process.env.STRIPE_SECRET_KEY;
  setStripeClient(null);
  assert.equal(await canPayOnline(await place.asGuest()), false);
});

test("canPayOnline exposes no Payout Account details to guests", async () => {
  const place = await fixture();
  const res = await place.asGuest();
  assert.equal(res.body.canPayOnline, true);
  assert.doesNotMatch(JSON.stringify(res.body), /acct_|payout|chargesEnabled|onlinePaymentsEnabled|detailsSubmitted/i);
});

test("the owner switches online payments off and on again", async () => {
  const place = await fixture();

  const off = await place.payoutAccountAs.owner("patch").send({ onlinePaymentsEnabled: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(off.body, {
    connected: true,
    chargesEnabled: true,
    detailsSubmitted: true,
    onlinePaymentsEnabled: false,
  });
  assert.equal((await place.payoutAccountAs.owner("get")).body.onlinePaymentsEnabled, false);
  assert.equal(await canPayOnline(await place.asGuest()), false);

  const on = await place.payoutAccountAs.owner("patch").send({ onlinePaymentsEnabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.onlinePaymentsEnabled, true);
  assert.equal(await canPayOnline(await place.asGuest()), true);
});

test("before onboarding there is no Payout Account to switch: 409, and GET still reads as on", async () => {
  const place = await fixture({ connected: false });
  const res = await place.payoutAccountAs.owner("patch").send({ onlinePaymentsEnabled: false });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "PAYOUT_ACCOUNT_MISSING");
  assert.deepEqual((await place.payoutAccountAs.owner("get")).body, {
    connected: false,
    chargesEnabled: false,
    detailsSubmitted: false,
    onlinePaymentsEnabled: true,
  });
});

test("only the owner may switch online payments", async () => {
  const place = await fixture();
  for (const who of ["admin", "waiter", "guest"]) {
    const res = await place.payoutAccountAs[who]("patch").send({ onlinePaymentsEnabled: false });
    assert.equal(res.status, 403, who);
  }
  const anonymous = await request(app).patch("/api/v1/restaurant/payout-account").send({ onlinePaymentsEnabled: false });
  assert.equal(anonymous.status, 401);
  assert.equal(await canPayOnline(await place.asGuest()), true);
});

test("an invalid body is refused with 400", async () => {
  const place = await fixture();
  for (const body of [{}, { onlinePaymentsEnabled: "false" }, { onlinePaymentsEnabled: 0 }, { onlinePaymentsEnabled: null }]) {
    const res = await place.payoutAccountAs.owner("patch").send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "VALIDATION");
  }
  assert.equal(await canPayOnline(await place.asGuest()), true);
});
