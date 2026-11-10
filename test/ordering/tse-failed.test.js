process.env.JWT_SECRET = "test-secret-tse-failed";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateToken } from "../../src/shared/auth.js";
import { cancelOrder, createOrder } from "../../src/modules/ordering/order.service.js";
import { recordPayment } from "../../src/modules/payments/payment.service.js";
import { signing } from "../../src/modules/payments/signing.js";
import Payment from "../../src/modules/payments/payment.model.js";
import Order from "../../src/modules/ordering/order.model.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";
import { createFiskalyClient } from "../../src/modules/tse/fiskaly.client.js";
import { setFiskalyClient, setupTse } from "../../src/modules/tse/tse.service.js";
import { signPayment, MAX_AUTO_RETRIES } from "../../src/modules/tse/signing.service.js";
import { signOrder } from "../../src/modules/ordering/order.signing.js";
import { createFakeFiskaly } from "../support/fakeFiskaly.js";

const LEGAL = {
  legalName: "Pizzeria Roma GmbH",
  address: { street: "Hauptstraße 1", zip: "10115", city: "Berlin", country: "DE" },
  taxNumber: "27/123/45678",
};

let replset;
let app;
let request;
let fake;
const originalRequestSigning = signing.requestSigning;

let down = false;
// fiskaly answers every call with a 503 while `run` runs.
const whileFiskalyDown = async (run) => {
  down = true;
  try {
    return await run();
  } finally {
    down = false;
  }
};
const unavailable = () =>
  new Response(JSON.stringify({ status_code: 503, code: "E_UNAVAILABLE", message: "fiskaly is down" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });

const staffOf = (restaurant, position) => {
  const suffix = randomUUID().slice(0, 8);
  return Employee.create({
    restaurantId: restaurant._id,
    employee: `${position}-${suffix}`,
    email: `${position}-${suffix}@example.com`,
    password: "x".repeat(60),
    position,
    role: position,
  });
};

const fixture = async ({ tableNumber = 7 } = {}) => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({ name: `R${suffix}`, slug: `r-${suffix}`, legal: LEGAL });
  await setupTse(restaurant._id);
  const owner = await staffOf(restaurant, "owner");
  const admin = await staffOf(restaurant, "admin");
  const waiter = await staffOf(restaurant, "waiter");
  const table = await Table.create({ restaurantId: restaurant._id, tableNumber, capacity: 4 });
  const food = await Category.create({
    restaurantId: restaurant._id,
    name: "food",
    station: "kitchen",
    vatRate: "REDUCED_1",
    position: 1,
  });
  const drinks = await Category.create({
    restaurantId: restaurant._id,
    name: "drinks",
    station: "bar",
    vatRate: "NORMAL",
    position: 2,
  });
  const pizza = await MenuItem.create({
    restaurantId: restaurant._id,
    title: "Pizza",
    price: 12.5,
    priceCents: 1250,
    categoryId: food._id,
    inStock: true,
  });
  const beer = await MenuItem.create({
    restaurantId: restaurant._id,
    title: "Beer",
    price: 4.2,
    priceCents: 420,
    categoryId: drinks._id,
    inStock: true,
  });
  const ctx = () => ({
    restaurantId: restaurant._id,
    requestId: randomUUID(),
    actor: { type: "employee", id: waiter._id, position: "waiter" },
  });
  const order = async (items, sessionId) =>
    (
      await createOrder(ctx(), {
        clientOrderId: randomUUID(),
        ...(sessionId ? { sessionId } : { tableId: String(table._id) }),
        items: items.map(([item, quantity]) => ({ productId: String(item._id), quantity })),
      })
    ).order;
  const pay = async (sessionId, expectedTotalCents) =>
    (
      await recordPayment(ctx(), sessionId, {
        method: "CASH",
        clientPaymentId: randomUUID(),
        expectedTotalCents,
      })
    ).payment;
  const as = (who) => (method, path) =>
    request(app)[method](`/api/v1/tse${path}`).set("Authorization", `Bearer ${generateToken(who)}`);
  return { restaurant, ctx, order, pay, pizza, beer, asOwner: as(owner), asAdmin: as(admin), asWaiter: as(waiter) };
};

// A failed order, a signed order with a failed correction, and the bill's
// failed payment, in that order in time.
const failedThree = async (place) => {
  const failedOrder = await place.order([[place.beer, 2]]);
  await whileFiskalyDown(() => signOrder(failedOrder._id));

  const corrected = await place.order([[place.pizza, 1], [place.beer, 1]], failedOrder.sessionId);
  await signOrder(corrected._id);
  await cancelOrder(place.ctx(), { orderId: String(corrected._id), station: "bar", reason: "spilled" });
  await whileFiskalyDown(() => signOrder(corrected._id));

  const payment = await place.pay(failedOrder.sessionId, 840 + 1250);
  await whileFiskalyDown(() => signPayment(payment.id));

  return { payment, failedOrder, corrected };
};

test.before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_DB_URL = replset.getUri();
  await connectToDatabase();
  ({ default: request } = await import("supertest"));
  ({ default: app } = await import("../../src/app.js"));
  await Payment.init();
}, { timeout: 180000 });

test.beforeEach(() => {
  fake = createFakeFiskaly();
  const fetch = (...args) => (down ? unavailable() : fake.fetch(...args));
  setFiskalyClient(createFiskalyClient({ apiKey: "key", apiSecret: "secret", fetch }));
  // The tests sign by hand.
  signing.requestSigning = async () => {};
});

test.afterEach(() => {
  signing.requestSigning = originalRequestSigning;
});

test.after(async () => {
  setFiskalyClient(null);
  await disconnectDatabase();
  await replset?.stop();
});

test("the status counts failed payments, orders and corrections of this restaurant only", async () => {
  const place = await fixture();
  const other = await fixture();
  await failedThree(place);
  const otherOrder = await other.order([[other.beer, 1]]);
  await whileFiskalyDown(() => signOrder(otherOrder._id));

  const res = await place.asOwner("get", "");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.active, true);
  assert.equal(res.body.failedSignatures, 3);
  assert.equal((await other.asAdmin("get", "")).body.failedSignatures, 1);
});

test("the failed list is newest first with the fields of each signature", async () => {
  const place = await fixture({ tableNumber: 12 });
  await fixture();
  const { payment, failedOrder, corrected } = await failedThree(place);

  const res = await place.asAdmin("get", "/failed");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { items } = res.body;
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), ["amountCents", "at", "error", "id", "kind", "retryCount", "tableNumber"]);
    assert.equal(item.tableNumber, 12);
    assert.equal(item.retryCount, 1);
    assert.match(item.error, /^fiskaly 503 E_UNAVAILABLE: fiskaly is down$/);
    assert.ok(!Number.isNaN(Date.parse(item.at)));
  }
  assert.deepEqual(
    items.map((item) => [item.kind, item.id, item.amountCents]),
    [
      ["PAYMENT", String(payment.id), 2090],
      ["ORDER", String(corrected._id), -420],
      ["ORDER", String(failedOrder._id), 840],
    ]
  );
  const times = items.map((item) => Date.parse(item.at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test("retrying a failed payment with fiskaly up signs it and takes it off the list", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 2]]);
  await signOrder(placed._id);
  const payment = await place.pay(placed.sessionId, 2500);
  await whileFiskalyDown(() => signPayment(payment.id));
  // Past the automatic retry limit: only a person can push it through now.
  await Payment.updateOne(
    { _id: payment.id, restaurantId: place.restaurant._id },
    { $set: { "tse.retryCount": MAX_AUTO_RETRIES } }
  );

  const res = await place.asOwner("post", `/failed/PAYMENT/${payment.id}/retry`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { status: "SIGNED" });
  const saved = await Payment.findOne({ _id: payment.id, restaurantId: place.restaurant._id }).lean();
  assert.equal(saved.tse.status, "SIGNED");
  assert.deepEqual((await place.asOwner("get", "/failed")).body, { items: [] });
  assert.equal((await place.asOwner("get", "")).body.failedSignatures, 0);
});

test("retrying with fiskaly still down stays FAILED with retryCount 1", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  await signOrder(placed._id);
  const payment = await place.pay(placed.sessionId, 1250);
  await whileFiskalyDown(() => signPayment(payment.id));
  await Payment.updateOne(
    { _id: payment.id, restaurantId: place.restaurant._id },
    { $set: { "tse.retryCount": 5 } }
  );

  const res = await whileFiskalyDown(() => place.asAdmin("post", `/failed/PAYMENT/${payment.id}/retry`));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { status: "FAILED" });
  const [item] = (await place.asAdmin("get", "/failed")).body.items;
  assert.equal(item.id, String(payment.id));
  assert.equal(item.retryCount, 1);
});

test("retrying a failed order signs its Bestellung, and a failed correction is retried through its order", async () => {
  const place = await fixture();
  const { failedOrder, corrected } = await failedThree(place);
  await Order.updateOne(
    { _id: corrected._id, restaurantId: place.restaurant._id },
    { $set: { "tseCorrections.$[].retryCount": MAX_AUTO_RETRIES } }
  );

  const order = await place.asOwner("post", `/failed/ORDER/${failedOrder._id}/retry`);
  assert.deepEqual(order.body, { status: "SIGNED" });
  const correction = await place.asOwner("post", `/failed/ORDER/${corrected._id}/retry`);
  assert.deepEqual(correction.body, { status: "SIGNED" });
  const saved = await Order.findOne({ _id: corrected._id, restaurantId: place.restaurant._id }).lean();
  assert.ok(saved.tseCorrections.every((entry) => entry.status === "SIGNED"));

  const { items } = (await place.asOwner("get", "/failed")).body;
  assert.deepEqual(items.map((item) => item.kind), ["PAYMENT"]);
});

test("only the owner and admin of the restaurant see and retry its failed signatures", async () => {
  const place = await fixture();
  const other = await fixture();
  const { payment, failedOrder } = await failedThree(place);

  assert.equal((await place.asWaiter("get", "")).status, 403);
  assert.equal((await place.asWaiter("get", "/failed")).status, 403);
  assert.equal((await place.asWaiter("post", `/failed/PAYMENT/${payment.id}/retry`)).status, 403);

  assert.deepEqual((await other.asOwner("get", "/failed")).body, { items: [] });
  fake.clearCalls();
  assert.equal((await other.asOwner("post", `/failed/PAYMENT/${payment.id}/retry`)).status, 404);
  assert.equal((await other.asOwner("post", `/failed/ORDER/${failedOrder._id}/retry`)).status, 404);
  assert.equal((await place.asOwner("post", `/failed/ORDER/${payment.id}/retry`)).status, 404);
  assert.equal((await place.asOwner("post", `/failed/RECEIPT/${payment.id}/retry`)).status, 404);
  assert.equal((await place.asOwner("post", `/failed/PAYMENT/not-an-id/retry`)).status, 404);
  assert.equal(
    (await place.asOwner("post", `/failed/PAYMENT/${new mongoose.Types.ObjectId()}/retry`)).status,
    404
  );
  assert.deepEqual(fake.calls, []);
  const saved = await Payment.findOne({ _id: payment.id, restaurantId: place.restaurant._id }).lean();
  assert.equal(saved.tse.status, "FAILED");
});
