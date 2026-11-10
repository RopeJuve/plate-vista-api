process.env.JWT_SECRET = "test-secret-order-signing";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.INTERNAL_SECRET = "internal-secret-for-order-signing";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import {
  cancelOrder,
  changeStatus,
  createOrder,
  executeOrderCommand,
  updateOrder,
} from "../../src/modules/ordering/order.service.js";
import { signOrder } from "../../src/modules/ordering/order.signing.js";
import { signing } from "../../src/modules/payments/signing.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";
import { createFiskalyClient } from "../../src/modules/tse/fiskaly.client.js";
import { setFiskalyClient, setupTse } from "../../src/modules/tse/tse.service.js";
import { MAX_AUTO_RETRIES } from "../../src/modules/tse/signing.service.js";
import { createTseSweep } from "../../src/jobs/tseSweep.js";
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
let client;
let requested;
const originalRequestSigning = signing.requestSigning;

const fixture = async ({ tse = true } = {}) => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({ name: `R${suffix}`, slug: `r-${suffix}`, legal: LEGAL });
  if (tse) await setupTse(restaurant._id);
  const tseOf = (await Restaurant.findById(restaurant._id).lean()).tse;
  const waiter = await Employee.create({
    restaurantId: restaurant._id,
    employee: `waiter-${suffix}`,
    email: `waiter-${suffix}@example.com`,
    password: "x".repeat(60),
    position: "waiter",
    role: "waiter",
  });
  const table = await Table.create({ restaurantId: restaurant._id, tableNumber: 1, capacity: 4 });
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
  const menuItem = (title, priceCents, category) =>
    MenuItem.create({
      restaurantId: restaurant._id,
      title,
      price: priceCents / 100,
      priceCents,
      categoryId: category._id,
      inStock: true,
    });
  const pizza = await menuItem("Pizza", 1250, food);
  const salad = await menuItem("Salad", 850, food);
  const beer = await menuItem("Beer", 450, drinks);
  const ctx = () => ({
    restaurantId: restaurant._id,
    requestId: randomUUID(),
    actor: { type: "employee", id: waiter._id, position: "waiter" },
  });
  const lines = (items) => items.map(([item, quantity]) => ({ productId: String(item._id), quantity }));
  const order = async (items) =>
    (
      await createOrder(ctx(), {
        clientOrderId: randomUUID(),
        tableId: String(table._id),
        items: lines(items),
      })
    ).order;
  const edit = async (orderId, items) => (await updateOrder(ctx(), { orderId, items: lines(items) })).order;
  const cancel = (orderId, station) => cancelOrder(ctx(), { orderId, station, reason: "spilled" });
  return { restaurant, tse: tseOf, ctx, order, edit, cancel, pizza, salad, beer, table };
};

const stored = (place, id) =>
  mongoose.connection.collection("orders").findOne({
    _id: new mongoose.Types.ObjectId(String(id)),
    restaurantId: place.restaurant._id,
  });
const finishCalls = () => fake.calls.filter((call) => call.op === "finishTx");
const lineItemsOf = (call) => call.body.schema.standard_v1.order.line_items;
const txOf = (place, txId) => fake.tss(place.tse.tssId).transactions.get(txId);

const waitFor = async (check, { timeout = 5000 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test.before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_DB_URL = replset.getUri();
  await connectToDatabase();
  ({ default: request } = await import("supertest"));
  ({ default: app } = await import("../../src/app.js"));
}, { timeout: 180000 });

test.beforeEach(async () => {
  // The sweep looks across restaurants: no test sees another's orders.
  await mongoose.connection.collection("orders").deleteMany({});
  fake = createFakeFiskaly();
  client = createFiskalyClient({ apiKey: "key", apiSecret: "secret", fetch: fake.fetch });
  setFiskalyClient(client);
  requested = [];
  // Tests call signOrder themselves.
  signing.requestSigning = async (target) => {
    requested.push(target);
  };
});

test.afterEach(() => {
  signing.requestSigning = originalRequestSigning;
});

test.after(async () => {
  setFiskalyClient(null);
  await disconnectDatabase();
  await replset?.stop();
});

test("a new order is PENDING, asks for its signature, and is signed as a Bestellung", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 2], [place.beer, 1]]);

  let saved = await stored(place, placed._id);
  assert.equal(saved.tse.status, "PENDING");
  assert.deepEqual(requested, [{ kind: "ORDER", id: placed._id }]);
  fake.clearCalls();

  await signOrder(placed._id);

  saved = await stored(place, placed._id);
  assert.equal(saved.tse.status, "SIGNED");
  assert.deepEqual(fake.ops({ withAuth: false }), ["startTx", "finishTx"]);
  assert.deepEqual(lineItemsOf(finishCalls()[0]), [
    { quantity: "2", text: "Pizza", price_per_unit: "12.50" },
    { quantity: "1", text: "Beer", price_per_unit: "4.50" },
  ]);
  const tx = txOf(place, saved.tse.txId);
  assert.equal(tx.state, "FINISHED");
  assert.equal(finishCalls()[0].body.client_id, place.tse.clientId);
  assert.equal(saved.tse.txNumber, tx.number);
  assert.equal(saved.tse.signatureCounter, tx.signature.counter);
  assert.equal(saved.tse.revision, 2);
  assert.equal(saved.tse.timeEnd.getTime(), tx.time_end * 1000);
  assert.equal(saved.tse.lockedUntil ?? null, null);
  assert.equal(saved.tse.lastError ?? null, null);
  // A signed order is not signed again.
  fake.clearCalls();
  assert.equal(await signOrder(placed._id), null);
  assert.deepEqual(fake.ops(), []);
});

test("a restaurant without a TSE takes orders without any signature or fiskaly call", async () => {
  const place = await fixture({ tse: false });
  fake.clearCalls();
  const placed = await place.order([[place.pizza, 1]]);

  const saved = await stored(place, placed._id);
  assert.equal(saved.tse, undefined);
  assert.deepEqual(saved.tseCorrections ?? [], []);
  assert.deepEqual(requested, []);
  await place.cancel(placed._id, "kitchen");
  assert.equal(await signOrder(placed._id), null);
  await createTseSweep().runOnce();
  assert.deepEqual(fake.ops(), []);
  assert.equal((await stored(place, placed._id)).tse, undefined);
});

test("a replayed order does not ask for a second signature", async () => {
  const place = await fixture();
  const clientOrderId = randomUUID();
  const body = { clientOrderId, tableId: String(place.table._id), items: [{ productId: String(place.pizza._id), quantity: 1 }] };
  await createOrder(place.ctx(), body);
  const again = await createOrder(place.ctx(), body);
  assert.equal(again.replayed, true);
  assert.equal(requested.length, 1);
});

test("an order placed with the WebSocket order.create command asks for its signature", async () => {
  const place = await fixture();
  const { order } = await executeOrderCommand(place.ctx(), {
    type: "order.create",
    payload: {
      clientOrderId: randomUUID(),
      tableId: String(place.table._id),
      items: [{ productId: String(place.beer._id), quantity: 2 }],
    },
  });
  assert.deepEqual(requested, [{ kind: "ORDER", id: order._id }]);
  assert.equal((await stored(place, order._id)).tse.status, "PENDING");
});

test("with fiskaly down the order still works through the kitchen, and the sweep signs it later", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  fake.failNext("startTx", { status: 503, code: "E_UNAVAILABLE", message: "try later" });

  const before = Date.now();
  await signOrder(placed._id);
  let saved = await stored(place, placed._id);
  assert.equal(saved.tse.status, "FAILED");
  assert.match(saved.tse.lastError, /E_UNAVAILABLE/);
  assert.equal(saved.tse.retryCount, 1);
  const delay = saved.tse.nextAttemptAt.getTime() - before;
  assert.ok(delay >= 30_000 && delay < 32_000, `first backoff was ${delay} ms`);
  assert.equal(saved.tse.lockedUntil ?? null, null);

  for (const status of ["accepted", "preparing", "ready", "served"]) {
    const { order } = await changeStatus(place.ctx(), { orderId: placed._id, status });
    assert.equal(order.status, status);
  }

  fake.clearCalls();
  await createTseSweep().runOnce();
  assert.deepEqual(finishCalls(), [], "not due yet");

  await createTseSweep({ now: () => new Date(Date.now() + 31_000) }).runOnce();
  saved = await stored(place, placed._id);
  assert.equal(saved.tse.status, "SIGNED");
  assert.deepEqual(lineItemsOf(finishCalls()[0]), [{ quantity: "1", text: "Pizza", price_per_unit: "12.50" }]);
});

test("after 20 failures the order is no longer retried automatically", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  for (let attempt = 1; attempt <= MAX_AUTO_RETRIES; attempt += 1) {
    fake.failNext(attempt === 1 ? "startTx" : "getTx", { status: 500 });
    await signOrder(placed._id);
  }
  const saved = await stored(place, placed._id);
  assert.equal(saved.tse.status, "FAILED");
  assert.equal(saved.tse.retryCount, MAX_AUTO_RETRIES);
  fake.clearCalls();
  await createTseSweep({ now: () => new Date(Date.now() + 365 * 24 * 3600_000) }).runOnce();
  assert.equal(await signOrder(placed._id), null);
  assert.deepEqual(fake.ops(), []);
});

test("a ticket cancelled before signing is left out of the Bestellung, with no correction", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1], [place.beer, 2]]);
  await place.cancel(placed._id, "bar");
  fake.clearCalls();

  await signOrder(placed._id);

  const saved = await stored(place, placed._id);
  assert.equal(saved.tse.status, "SIGNED");
  assert.deepEqual(lineItemsOf(finishCalls()[0]), [{ quantity: "1", text: "Pizza", price_per_unit: "12.50" }]);
  assert.deepEqual(saved.tseCorrections ?? [], []);
});

test("an order cancelled whole before signing is never signed", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1], [place.beer, 2]]);
  await place.cancel(placed._id);
  fake.clearCalls();

  await signOrder(placed._id);
  await createTseSweep().runOnce();

  assert.deepEqual(fake.ops(), []);
  const saved = await stored(place, placed._id);
  assert.equal(saved.tse, undefined);
  assert.deepEqual(saved.tseCorrections ?? [], []);
});

test("an order cancelled whole after its Bestellung was started is finished, then corrected", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  fake.failNext("finishTx", { status: 503, code: "E_UNAVAILABLE", message: "try later" });
  await signOrder(placed._id);
  assert.equal((await stored(place, placed._id)).tse.status, "FAILED");
  await place.cancel(placed._id);
  fake.clearCalls();

  await signOrder(placed._id);

  const saved = await stored(place, placed._id);
  assert.equal(saved.tse.status, "SIGNED");
  assert.equal(saved.tseCorrections.length, 1);
  assert.equal(saved.tseCorrections[0].status, "SIGNED");
  const [bestellung, correction] = finishCalls();
  assert.deepEqual(lineItemsOf(bestellung), [{ quantity: "1", text: "Pizza", price_per_unit: "12.50" }]);
  assert.deepEqual(lineItemsOf(correction), [{ quantity: "-1", text: "Pizza", price_per_unit: "12.50" }]);
});

test("a ticket cancelled after signing is signed as a correction of exactly that ticket's lines", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 2], [place.salad, 1], [place.beer, 3]]);
  await signOrder(placed._id);
  requested = [];

  await place.cancel(placed._id, "kitchen");

  let saved = await stored(place, placed._id);
  assert.equal(saved.tseCorrections.length, 1);
  assert.equal(saved.tseCorrections[0].station, "kitchen");
  assert.equal(saved.tseCorrections[0].status, "PENDING");
  assert.deepEqual(requested, [{ kind: "ORDER", id: placed._id }]);
  fake.clearCalls();

  await signOrder(placed._id);

  saved = await stored(place, placed._id);
  const [correction] = saved.tseCorrections;
  assert.equal(correction.status, "SIGNED");
  assert.deepEqual(fake.ops({ withAuth: false }), ["startTx", "finishTx"]);
  assert.deepEqual(lineItemsOf(finishCalls()[0]), [
    { quantity: "-2", text: "Pizza", price_per_unit: "12.50" },
    { quantity: "-1", text: "Salad", price_per_unit: "8.50" },
  ]);
  const tx = txOf(place, correction.txId);
  assert.equal(tx.state, "FINISHED");
  assert.equal(correction.txNumber, tx.number);
  assert.notEqual(correction.txId, saved.tse.txId);
});

test("an edit after signing is signed as a correction for the difference", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 2], [place.beer, 1]]);
  await signOrder(placed._id);

  await place.edit(placed._id, [[place.pizza, 1], [place.beer, 1], [place.salad, 1]]);
  fake.clearCalls();
  await signOrder(placed._id);

  const saved = await stored(place, placed._id);
  assert.equal(saved.tseCorrections.length, 1);
  assert.equal(saved.tseCorrections[0].status, "SIGNED");
  assert.deepEqual(lineItemsOf(finishCalls()[0]), [
    { quantity: "-1", text: "Pizza", price_per_unit: "12.50" },
    { quantity: "1", text: "Salad", price_per_unit: "8.50" },
  ]);
});

test("an edit before signing changes what the Bestellung signs", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 2]]);
  await place.edit(placed._id, [[place.beer, 1]]);
  fake.clearCalls();

  await signOrder(placed._id);

  assert.deepEqual(lineItemsOf(finishCalls()[0]), [{ quantity: "1", text: "Beer", price_per_unit: "4.50" }]);
  assert.deepEqual((await stored(place, placed._id)).tseCorrections ?? [], []);
});

test("a failed correction backs off and the sweep signs it later", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1], [place.beer, 1]]);
  await signOrder(placed._id);
  await place.cancel(placed._id, "bar");
  fake.failNext("startTx", { status: 503, code: "E_UNAVAILABLE", message: "try later" });

  const before = Date.now();
  await signOrder(placed._id);
  let [correction] = (await stored(place, placed._id)).tseCorrections;
  assert.equal(correction.status, "FAILED");
  assert.match(correction.lastError, /E_UNAVAILABLE/);
  assert.equal(correction.retryCount, 1);
  const delay = correction.nextAttemptAt.getTime() - before;
  assert.ok(delay >= 30_000 && delay < 32_000, `first backoff was ${delay} ms`);
  assert.equal((await stored(place, placed._id)).tse.status, "SIGNED");

  fake.clearCalls();
  await createTseSweep().runOnce();
  assert.deepEqual(finishCalls(), [], "not due yet");

  await createTseSweep({ now: () => new Date(Date.now() + 31_000) }).runOnce();
  [correction] = (await stored(place, placed._id)).tseCorrections;
  assert.equal(correction.status, "SIGNED");
  assert.deepEqual(lineItemsOf(finishCalls()[0]), [{ quantity: "-1", text: "Beer", price_per_unit: "4.50" }]);
});

test("a cancel while the order is being signed still ends in a correction, once", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1], [place.beer, 1]]);
  let cancelled = false;
  // The cancel lands after the signer read the order, before fiskaly finished.
  setFiskalyClient({
    ...client,
    finishTx: async (...args) => {
      if (!cancelled) {
        cancelled = true;
        await place.cancel(placed._id, "bar");
      }
      return client.finishTx(...args);
    },
  });

  await signOrder(placed._id);
  await signOrder(placed._id);

  const saved = await stored(place, placed._id);
  assert.equal(saved.tse.status, "SIGNED");
  assert.equal(saved.tseCorrections.length, 1);
  assert.equal(saved.tseCorrections[0].status, "SIGNED");
  const finishes = finishCalls();
  assert.deepEqual(lineItemsOf(finishes[0]), [
    { quantity: "1", text: "Pizza", price_per_unit: "12.50" },
    { quantity: "1", text: "Beer", price_per_unit: "4.50" },
  ]);
  assert.deepEqual(lineItemsOf(finishes[1]), [{ quantity: "-1", text: "Beer", price_per_unit: "4.50" }]);
});

test("orders from before signing existed are never signed", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  await mongoose.connection
    .collection("orders")
    .updateOne({ _id: new mongoose.Types.ObjectId(placed._id) }, { $unset: { tse: "" } });
  await place.cancel(placed._id, "kitchen");
  fake.clearCalls();

  assert.equal(await signOrder(placed._id), null);
  await createTseSweep().runOnce();
  assert.deepEqual(fake.ops(), []);
  assert.deepEqual((await stored(place, placed._id)).tseCorrections ?? [], []);
});

test("the sweep signs payments and orders in one batch of at most 50", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  let asked;
  const { findDueSignatures } = await import("../../src/modules/tse/signing.service.js");
  const sweep = createTseSweep({
    findDue: async (query) => {
      asked = query;
      return findDueSignatures(query);
    },
  });
  await sweep.runOnce();
  assert.equal(asked.limit, 50);
  assert.equal((await stored(place, placed._id)).tse.status, "SIGNED");
  const due = await findDueSignatures({ now: new Date(), limit: 50 });
  assert.equal(due.length, 0);
});

test("locally, placing an order signs it in-process after the reply", async () => {
  signing.requestSigning = originalRequestSigning;
  const place = await fixture();
  const placed = await place.order([[place.beer, 1]]);
  await waitFor(async () => (await stored(place, placed._id)).tse.status === "SIGNED");
});

test("POST /internal/sign signs an order", async () => {
  const place = await fixture();
  const placed = await place.order([[place.beer, 1]]);
  const res = await request(app)
    .post("/internal/sign")
    .set("x-internal-secret", process.env.INTERNAL_SECRET)
    .send({ kind: "ORDER", id: placed._id });
  assert.equal(res.status, 202);
  await waitFor(async () => (await stored(place, placed._id)).tse.status === "SIGNED");
});
