process.env.JWT_SECRET = "test-secret-signing";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.INTERNAL_SECRET = "internal-secret-for-signing-tests";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { cancelOrder, createOrder } from "../../src/modules/ordering/order.service.js";
import { recordPayment } from "../../src/modules/payments/payment.service.js";
import { signing } from "../../src/modules/payments/signing.js";
import { paymentEvents } from "../../src/modules/payments/events.js";
import { clearPublished, published } from "../../src/realtime/events.js";
import Payment from "../../src/modules/payments/payment.model.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";
import { createFiskalyClient, FiskalyError } from "../../src/modules/tse/fiskaly.client.js";
import { setFiskalyClient, setupTse } from "../../src/modules/tse/tse.service.js";
import { signPayment, MAX_AUTO_RETRIES } from "../../src/modules/tse/signing.service.js";
import { signOrder } from "../../src/modules/ordering/order.signing.js";
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
const originalRequestSigning = signing.requestSigning;

const fixture = async () => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({ name: `R${suffix}`, slug: `r-${suffix}`, legal: LEGAL });
  await setupTse(restaurant._id);
  const tse = (await Restaurant.findById(restaurant._id).lean()).tse;
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
  const pizza = await MenuItem.create({
    restaurantId: restaurant._id,
    title: "Pizza",
    priceCents: 1250,
    categoryId: food._id,
    inStock: true,
  });
  const beer = await MenuItem.create({
    restaurantId: restaurant._id,
    title: "Beer",
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
  const pay = async (sessionId, method, expectedTotalCents) =>
    (
      await recordPayment(ctx(), sessionId, {
        method,
        clientPaymentId: randomUUID(),
        expectedTotalCents,
      })
    ).payment;
  return { restaurant, tse, ctx, order, pay, pizza, beer };
};

const stored = (place, id) => Payment.findOne({ _id: id, restaurantId: place.restaurant._id }).lean();
const finishCalls = () => fake.calls.filter((call) => call.op === "finishTx");
const receiptOf = (call) => call.body.schema.standard_v1.receipt;
const cents = (amount) => Math.round(Number(amount) * 100);

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
  await Payment.init();
}, { timeout: 180000 });

test.beforeEach(() => {
  fake = createFakeFiskaly();
  client = createFiskalyClient({ apiKey: "key", apiSecret: "secret", fetch: fake.fetch });
  setFiskalyClient(client);
  // Most tests call signPayment themselves. Orders are signed as soon as
  // they are placed, so the sweeps here only find payments.
  signing.requestSigning = async ({ kind, id }) => {
    if (kind === "ORDER") await signOrder(id);
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

test("a cash payment is signed as a Kassenbeleg with every signature field", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 2]]);
  const payment = await place.pay(placed.sessionId, "CASH", 2500);
  fake.clearCalls();

  await signPayment(payment.id);

  const saved = await stored(place, payment.id);
  assert.equal(saved.tse.status, "SIGNED");
  const finish = finishCalls();
  assert.equal(finish.length, 1);
  assert.deepEqual(receiptOf(finish[0]), {
    receipt_type: "RECEIPT",
    amounts_per_vat_rate: [{ vat_rate: "REDUCED_1", amount: "25.00" }],
    amounts_per_payment_type: [{ payment_type: "CASH", amount: "25.00" }],
  });
  assert.equal(finish[0].body.client_id, place.tse.clientId);
  assert.ok(finish[0].path.startsWith(`/tss/${place.tse.tssId}/tx/${saved.tse.txId}`));

  const tx = fake.tss(place.tse.tssId).transactions.get(saved.tse.txId);
  assert.equal(saved.tse.txNumber, tx.number);
  assert.equal(saved.tse.signatureValue, tx.signature.value);
  assert.equal(saved.tse.signatureCounter, tx.signature.counter);
  assert.equal(saved.tse.tssSerial, tx.tss_serial_number);
  assert.equal(saved.tse.clientSerial, tx.client_serial_number);
  assert.equal(saved.tse.qrCodeData, tx.qr_code_data);
  assert.equal(saved.tse.timeStart.getTime(), tx.time_start * 1000);
  assert.equal(saved.tse.timeEnd.getTime(), tx.time_end * 1000);
  assert.equal(saved.tse.revision, 2);
  assert.equal(saved.tse.lockedUntil ?? null, null);
  assert.equal(saved.tse.lastError ?? null, null);
});

test("a card terminal payment is sent as NON_CASH", async () => {
  const place = await fixture();
  const placed = await place.order([[place.beer, 1]]);
  const payment = await place.pay(placed.sessionId, "CARD_TERMINAL", 420);
  fake.clearCalls();

  await signPayment(payment.id);

  assert.equal((await stored(place, payment.id)).tse.status, "SIGNED");
  assert.deepEqual(receiptOf(finishCalls()[0]).amounts_per_payment_type, [
    { payment_type: "NON_CASH", amount: "4.20" },
  ]);
});

test("a mixed-rate bill sends one amount per VAT rate that add up to the payment", async () => {
  const place = await fixture();
  const first = await place.order([[place.pizza, 1], [place.beer, 2]]);
  await place.order([[place.pizza, 2]], first.sessionId);
  // A cancelled ticket is off the bill and off the receipt.
  const cancelled = await place.order([[place.beer, 3]], first.sessionId);
  await cancelOrder(place.ctx(), { orderId: String(cancelled._id), station: "bar", reason: "spilled" });
  const payment = await place.pay(first.sessionId, "CASH", 1250 * 3 + 420 * 2);
  fake.clearCalls();

  await signPayment(payment.id);

  const receipt = receiptOf(finishCalls()[0]);
  assert.deepEqual(receipt.amounts_per_vat_rate, [
    { vat_rate: "NORMAL", amount: "8.40" },
    { vat_rate: "REDUCED_1", amount: "37.50" },
  ]);
  const total = receipt.amounts_per_vat_rate.reduce((sum, entry) => sum + cents(entry.amount), 0);
  assert.equal(total, payment.amountCents);
  assert.equal(cents(receipt.amounts_per_payment_type[0].amount), payment.amountCents);
});

test("a fiskaly failure marks the payment FAILED with backoff, and the next sweep signs it", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  const payment = await place.pay(placed.sessionId, "CASH", 1250);
  fake.failNext("finishTx", { status: 503, code: "E_UNAVAILABLE", message: "try later" });

  const before = Date.now();
  await signPayment(payment.id);
  let saved = await stored(place, payment.id);
  assert.equal(saved.tse.status, "FAILED");
  assert.match(saved.tse.lastError, /E_UNAVAILABLE/);
  assert.equal(saved.tse.retryCount, 1);
  const delay = saved.tse.nextAttemptAt.getTime() - before;
  assert.ok(delay >= 30_000 && delay < 32_000, `first backoff was ${delay} ms`);
  assert.equal(saved.tse.lockedUntil ?? null, null);
  const txId = saved.tse.txId;
  assert.ok(txId);

  // Not due yet: the sweep leaves it alone.
  fake.clearCalls();
  await createTseSweep().runOnce();
  assert.equal(finishCalls().length, 0);
  assert.equal((await stored(place, payment.id)).tse.status, "FAILED");

  fake.failNext("getTx", { status: 500 });
  await createTseSweep({ now: () => new Date(Date.now() + 31_000) }).runOnce();
  saved = await stored(place, payment.id);
  assert.equal(saved.tse.retryCount, 2);
  const second = saved.tse.nextAttemptAt.getTime() - Date.now();
  assert.ok(second > 55_000 && second <= 60_000, `second backoff was ${second} ms`);

  fake.clearCalls();
  await createTseSweep({ now: () => new Date(Date.now() + 61_000) }).runOnce();
  saved = await stored(place, payment.id);
  assert.equal(saved.tse.status, "SIGNED");
  // The same transaction is finished, not a new one started.
  assert.equal(saved.tse.txId, txId);
  assert.deepEqual(fake.ops({ withAuth: false }), ["getTx", "finishTx"]);
  assert.ok(saved.tse.signatureValue);
});

test("a transaction fiskaly finished before our save failed is picked up, not finished again", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  const payment = await place.pay(placed.sessionId, "CASH", 1250);
  const txId = randomUUID();
  await Payment.updateOne(
    { _id: payment.id, restaurantId: place.restaurant._id },
    { $set: { "tse.txId": txId, "tse.status": "FAILED", "tse.retryCount": 1 } }
  );
  await client.startTx(place.tse.tssId, txId, { clientId: place.tse.clientId });
  const finished = await client.finishTx(place.tse.tssId, txId, { clientId: place.tse.clientId });
  fake.clearCalls();

  await signPayment(payment.id);

  const saved = await stored(place, payment.id);
  assert.equal(saved.tse.status, "SIGNED");
  assert.equal(saved.tse.signatureValue, finished.signature.value);
  assert.deepEqual(fake.ops({ withAuth: false }), ["getTx"]);
});

test("the ping and the sweep at the same time finish the fiskaly transaction once", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  const payment = await place.pay(placed.sessionId, "CASH", 1250);
  fake.clearCalls();

  await Promise.all([signPayment(payment.id), createTseSweep().runOnce(), signPayment(payment.id)]);

  assert.equal(finishCalls().length, 1);
  assert.equal(fake.calls.filter((call) => call.op === "startTx").length, 1);
  assert.equal((await stored(place, payment.id)).tse.status, "SIGNED");
});

test("after 20 failures the payment stays FAILED and is no longer retried automatically", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  const payment = await place.pay(placed.sessionId, "CASH", 1250);

  let saved;
  for (let attempt = 1; attempt <= MAX_AUTO_RETRIES; attempt += 1) {
    fake.failNext(attempt === 1 ? "startTx" : "getTx", { status: 500 });
    const before = Date.now();
    await signPayment(payment.id);
    saved = await stored(place, payment.id);
    assert.equal(saved.tse.retryCount, attempt);
    const delay = saved.tse.nextAttemptAt.getTime() - before;
    assert.ok(delay <= 30 * 60_000 + 1000, `backoff ${delay} ms is capped at 30 min`);
  }
  assert.equal(saved.tse.status, "FAILED");
  assert.ok(saved.tse.nextAttemptAt.getTime() - Date.now() > 29 * 60_000);

  fake.clearCalls();
  await createTseSweep({ now: () => new Date(Date.now() + 365 * 24 * 3600_000) }).runOnce();
  assert.deepEqual(fake.ops(), []);
  assert.equal((await stored(place, payment.id)).tse.status, "FAILED");

  // A ping or /internal/sign doesn't get round the limit either.
  assert.equal(await signPayment(payment.id), null);
  assert.deepEqual(fake.ops(), []);
  assert.equal((await stored(place, payment.id)).tse.retryCount, MAX_AUTO_RETRIES);
});

test("a line from before categories had a VAT rate is signed at its station's rate", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1], [place.beer, 1]]);
  // Older orders were stored without a rate on their lines (ADR-0004).
  await mongoose.connection
    .collection("orders")
    .updateOne({ _id: new mongoose.Types.ObjectId(String(placed._id)) }, { $unset: { "items.$[].vatRate": "" } });
  const payment = await place.pay(placed.sessionId, "CASH", 1250 + 420);
  fake.clearCalls();

  await signPayment(payment.id);

  assert.deepEqual(receiptOf(finishCalls()[0]).amounts_per_vat_rate, [
    { vat_rate: "NORMAL", amount: "4.20" },
    { vat_rate: "REDUCED_1", amount: "12.50" },
  ]);
});

test("a signer whose lock ran out cannot turn a SIGNED payment back to FAILED", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  const payment = await place.pay(placed.sessionId, "CASH", 1250);
  let stalled = true;
  // The first signer stalls in finishTx past its lock; a second signer signs
  // the payment meanwhile; then the first one's fiskaly call fails.
  setFiskalyClient({
    ...client,
    finishTx: async (...args) => {
      if (!stalled) return client.finishTx(...args);
      stalled = false;
      await Payment.updateOne(
        { _id: payment.id, restaurantId: place.restaurant._id },
        { $set: { "tse.lockedUntil": new Date(Date.now() - 1000) } }
      );
      assert.equal((await signPayment(payment.id)).tse.status, "SIGNED");
      throw new FiskalyError({ status: 503, code: "E_UNAVAILABLE", message: "too late" });
    },
  });

  assert.equal(await signPayment(payment.id), null);

  const saved = await stored(place, payment.id);
  assert.equal(saved.tse.status, "SIGNED");
  assert.equal(saved.tse.lastError ?? null, null);
  assert.equal(saved.tse.retryCount ?? 0, 0);
});

test("a bill that doesn't add up to the payment fails for good, without retries", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  const payment = await place.pay(placed.sessionId, "CASH", 1250);
  await Payment.updateOne(
    { _id: payment.id, restaurantId: place.restaurant._id },
    { $set: { amountCents: 1300 } }
  );
  fake.clearCalls();

  await signPayment(payment.id);

  const saved = await stored(place, payment.id);
  assert.equal(saved.tse.status, "FAILED");
  assert.match(saved.tse.lastError, /1250 cents but the payment is 1300/);
  assert.equal(saved.tse.retryCount, MAX_AUTO_RETRIES);
  assert.deepEqual(fake.ops({ withAuth: false }), []);
  await createTseSweep({ now: () => new Date(Date.now() + 365 * 24 * 3600_000) }).runOnce();
  assert.deepEqual(fake.ops({ withAuth: false }), []);
});

test("a fiskaly transaction that ended CANCELLED is replaced by a new one", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  const payment = await place.pay(placed.sessionId, "CASH", 1250);
  const cancelledTxId = randomUUID();
  await Payment.updateOne(
    { _id: payment.id, restaurantId: place.restaurant._id },
    { $set: { "tse.txId": cancelledTxId, "tse.status": "FAILED", "tse.retryCount": 1 } }
  );
  await client.startTx(place.tse.tssId, cancelledTxId, { clientId: place.tse.clientId });
  await client.cancelTx(place.tse.tssId, cancelledTxId, { clientId: place.tse.clientId });
  fake.clearCalls();

  await signPayment(payment.id);

  const saved = await stored(place, payment.id);
  assert.equal(saved.tse.status, "SIGNED");
  assert.notEqual(saved.tse.txId, cancelledTxId);
  assert.deepEqual(fake.ops({ withAuth: false }), ["getTx", "startTx", "finishTx"]);
});

test("the sweep picks up a payment whose ping never arrived", async () => {
  const place = await fixture();
  const placed = await place.order([[place.beer, 1]]);
  const payment = await place.pay(placed.sessionId, "CARD_TERMINAL", 420);
  assert.equal((await stored(place, payment.id)).tse.status, "PENDING");

  await createTseSweep().runOnce();

  assert.equal((await stored(place, payment.id)).tse.status, "SIGNED");
});

test("locally, recording a payment signs it in-process after the reply", async () => {
  signing.requestSigning = originalRequestSigning;
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  const payment = await place.pay(placed.sessionId, "CASH", 1250);
  assert.equal(payment.signature.status, "PENDING");

  const saved = await waitFor(async () => {
    const current = await stored(place, payment.id);
    return current.tse.status === "SIGNED" ? current : null;
  });
  assert.ok(saved.tse.qrCodeData);
});

test("POST /internal/sign needs the internal secret and signs the payment", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  const payment = await place.pay(placed.sessionId, "CASH", 1250);

  const missing = await request(app).post("/internal/sign").send({ kind: "PAYMENT", id: payment.id });
  assert.equal(missing.status, 401);
  const wrong = await request(app)
    .post("/internal/sign")
    .set("x-internal-secret", "not-the-internal-secret-at-all")
    .send({ kind: "PAYMENT", id: payment.id });
  assert.equal(wrong.status, 401);
  assert.equal((await stored(place, payment.id)).tse.status, "PENDING");

  const invalid = await request(app)
    .post("/internal/sign")
    .set("x-internal-secret", process.env.INTERNAL_SECRET)
    .send({ kind: "ORDER", id: "nope" });
  assert.equal(invalid.status, 400);

  const ok = await request(app)
    .post("/internal/sign")
    .set("x-internal-secret", process.env.INTERNAL_SECRET)
    .send({ kind: "PAYMENT", id: payment.id });
  assert.equal(ok.status, 202);
  await waitFor(async () => (await stored(place, payment.id)).tse.status === "SIGNED");
});

const signingEvents = () =>
  published.filter((entry) => ["payment.signed", "payment.signFailed"].includes(entry.message?.event));

test("signing a payment publishes payment.signed to the staff and the session", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  const payment = await place.pay(placed.sessionId, "CASH", 1250);
  clearPublished();

  await signPayment(payment.id);

  const envelopes = signingEvents();
  assert.equal(envelopes.length, 1);
  const [envelope] = envelopes;
  assert.equal(String(envelope.restaurantId), String(place.restaurant._id));
  assert.equal(String(envelope.sessionId), placed.sessionId);
  assert.equal(envelope.audience, undefined);
  assert.deepEqual(envelope.message, {
    type: "event",
    event: "payment.signed",
    data: { paymentId: payment.id, receiptToken: payment.receiptToken },
  });
});

test("the sweep signing a payment publishes payment.signed too", async () => {
  const place = await fixture();
  const placed = await place.order([[place.beer, 1]]);
  const payment = await place.pay(placed.sessionId, "CARD_TERMINAL", 420);
  clearPublished();

  await createTseSweep().runOnce();

  assert.deepEqual(
    signingEvents().map((entry) => [entry.message.event, entry.message.data.paymentId]),
    [["payment.signed", payment.id]]
  );
});

test("a failed signing attempt publishes payment.signFailed to the staff only", async () => {
  const place = await fixture();
  const placed = await place.order([[place.pizza, 1]]);
  const payment = await place.pay(placed.sessionId, "CASH", 1250);
  fake.failNext("finishTx", { status: 503, code: "E_UNAVAILABLE", message: "try later" });
  clearPublished();

  await signPayment(payment.id);

  const envelopes = signingEvents();
  assert.equal(envelopes.length, 1);
  const [envelope] = envelopes;
  assert.equal(String(envelope.restaurantId), String(place.restaurant._id));
  assert.equal(envelope.audience, "staff");
  assert.deepEqual(envelope.message, {
    type: "event",
    event: "payment.signFailed",
    data: { paymentId: payment.id },
  });
});

test("a throwing publish does not break signing, whether it succeeds or fails", async () => {
  const original = paymentEvents.publish;
  paymentEvents.publish = () => {
    throw new Error("socket server down");
  };
  try {
    const place = await fixture();
    const placed = await place.order([[place.pizza, 1]]);
    const payment = await place.pay(placed.sessionId, "CASH", 1250);

    fake.failNext("finishTx", { status: 503, code: "E_UNAVAILABLE", message: "try later" });
    const failed = await signPayment(payment.id);
    assert.equal(failed.tse.status, "FAILED");

    await Payment.updateOne(
      { _id: payment.id, restaurantId: place.restaurant._id },
      { $unset: { "tse.nextAttemptAt": 1 } }
    );
    const signed = await signPayment(payment.id);
    assert.equal(signed.tse.status, "SIGNED");
  } finally {
    paymentEvents.publish = original;
  }
});
