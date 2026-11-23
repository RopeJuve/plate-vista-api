process.env.JWT_SECRET = "test-secret-card-reader-payment-failure";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateTableToken, generateToken, hashPassword } from "../../src/shared/auth.js";
import { createOrder } from "../../src/modules/ordering/order.service.js";
import Payment from "../../src/modules/payments/payment.model.js";
import { signing } from "../../src/modules/payments/signing.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";
import { setStripeClient } from "../../src/modules/payouts/stripe.js";
import { clearPublished, published } from "../../src/realtime/events.js";
import { createFakeStripe } from "../support/fakeStripe.js";

const WEBHOOK_SECRET = "whsec_card_reader_payment_failure_test";
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_card_reader_payment",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  DASHBOARD_URL: "https://dashboard.example.com",
  GUEST_APP_URL: "https://guest.example.com",
  STRIPE_APPLICATION_FEE_BPS: "150",
};

const LEGAL = {
  legalName: "Trattoria Beispiel GmbH",
  address: { street: "Hauptstraße 1", zip: "10115", city: "Berlin", country: "DE" },
  taxNumber: "12/345/67890",
};

const CARD_READER_PAYMENT_KEYS = ["id", "sessionId", "reader", "amountCents", "status", "failure", "startedAt", "expiresAt"];

let replset;
let app;
let request;
let passwordHash;
let fake;
let signed = [];

const staffOf = (restaurant, position) =>
  Employee.create({
    restaurantId: restaurant._id,
    employee: `${position}-${randomUUID().slice(0, 8)}`,
    email: `${position}-${randomUUID().slice(0, 8)}@example.com`,
    password: passwordHash,
    position,
    role: position === "bar" || position === "kitchen" ? "staff" : position,
  });

// A restaurant that can take card reader payments: its Payout Account takes
// charges, the TSE is active, and a Simulated Reader named "Bar" is added
// (unless told otherwise). One table with an open bill of 14.50 €.
const place = async ({ chargesEnabled = true, tse = true, reader = "simulated" } = {}) => {
  const suffix = randomUUID().slice(0, 8);
  const stripeAccountId = `acct_${suffix}`;
  const restaurant = await Restaurant.create({
    name: `R${suffix}`,
    slug: `r-${suffix}`,
    legal: LEGAL,
    ...(tse ? { tse: { setupStep: "DONE", tssSerial: "serial", clientId: "client" } } : {}),
    payoutAccount: { stripeAccountId, chargesEnabled: true, detailsSubmitted: true },
  });
  const owner = await staffOf(restaurant, "owner");
  const waiter = await staffOf(restaurant, "waiter");
  const ownerToken = generateToken(owner);
  const waiterToken = generateToken(waiter);
  const barToken = generateToken(await staffOf(restaurant, "bar"));

  let readerId = null;
  if (reader === "simulated") {
    const res = await request(app)
      .post("/api/v1/restaurant/card-readers/simulated")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Bar" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    readerId = res.body.id;
  } else if (reader === "real") {
    const res = await request(app)
      .post("/api/v1/restaurant/card-readers")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ registrationCode: fake.pairingCode(), name: "Bar" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    readerId = res.body.id;
  }
  if (!chargesEnabled) {
    await Restaurant.updateOne({ _id: restaurant._id }, { $set: { "payoutAccount.chargesEnabled": false } });
  }

  const table = await Table.create({ restaurantId: restaurant._id, tableNumber: 4, capacity: 4 });
  const food = await Category.create({ restaurantId: restaurant._id, name: "food", station: "kitchen", position: 1 });
  const drinks = await Category.create({ restaurantId: restaurant._id, name: "drinks", station: "bar", position: 2 });
  const pizza = await MenuItem.create({
    restaurantId: restaurant._id, title: "Pizza", priceCents: 1000, categoryId: food._id, inStock: true,
  });
  const beer = await MenuItem.create({
    restaurantId: restaurant._id, title: "Beer", priceCents: 450, categoryId: drinks._id, inStock: true,
  });
  const ctx = {
    restaurantId: restaurant._id,
    requestId: randomUUID(),
    actor: { type: "employee", id: waiter._id, position: waiter.position },
  };
  const items = [{ productId: String(pizza._id), quantity: 1 }, { productId: String(beer._id), quantity: 1 }];
  const { order } = await createOrder(ctx, { clientOrderId: randomUUID(), tableId: String(table._id), items });
  const sessionId = order.sessionId;
  const guestToken = generateTableToken({ restaurantId: restaurant._id, tableId: table._id, sessionId });

  const as = (token) => (method, path, body) => {
    const req = request(app)[method](`/api/v1/sessions/${sessionId}${path}`).set("Authorization", `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };
  const asWaiter = as(waiterToken);
  return {
    restaurant,
    stripeAccountId,
    readerId,
    table,
    sessionId,
    ctx,
    items,
    asWaiter,
    asBar: as(barToken),
    asOwner: as(ownerToken),
    asGuest: as(guestToken),
    start: (body = {}) => asWaiter("post", "/card-reader-payment", { readerId, expectedTotalCents: 1450, ...body }),
    bill: (token = waiterToken) => as(token)("get", "/bill"),
    guestBill: () => as(guestToken)("get", "/bill"),
    payments: () => Payment.find({ restaurantId: restaurant._id, sessionId }).lean(),
  };
};

const callsOf = (op) => fake.calls.filter(([name]) => name === op);
const eventsNamed = (name) => published.filter((envelope) => envelope.message?.event === name);

const realRequestSigning = signing.requestSigning;

test.before(async () => {
  signing.requestSigning = async (target) => {
    signed.push(target);
  };
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
  fake = createFakeStripe();
  setStripeClient(fake);
  clearPublished();
  signed = [];
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

const deliver = (event, secret = WEBHOOK_SECRET) => {
  const { body, signature } = fake.signedEvent(event, secret);
  return request(app)
    .post("/api/v1/webhooks/stripe")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", signature)
    .send(body);
};

const stripeEvent = (p, type, object) => ({
  id: `evt_${randomUUID()}`,
  object: "event",
  type,
  account: p.stripeAccountId,
  livemode: false,
  created: Math.floor(Date.now() / 1000),
  data: { object },
});

// What Stripe sends when the card was declined, and when the reader's action
// failed, with the PaymentIntent and the reader as Stripe keeps them now.
const paymentFailedEvent = (p, paymentIntentId) =>
  stripeEvent(p, "payment_intent.payment_failed", fake.paymentIntent(paymentIntentId));
const readerOf = (p) => fake.readersOn(p.stripeAccountId)[0].id;
const actionFailedEvent = (p) => stripeEvent(p, "terminal.reader.action_failed", fake.reader(readerOf(p)));

const lastPaymentIntentId = () => callsOf("terminal.readers.processPaymentIntent").at(-1)[2].payment_intent;

const tap = async (p, card) => {
  const res = await p.asWaiter("post", "/card-reader-payment/test-card", { card });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
};

// Starts on the Simulated Reader, taps a declined test card and delivers
// Stripe's payment_failed webhook.
const startAndDecline = async (p, card = "INSUFFICIENT_FUNDS") => {
  const started = await p.start();
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await tap(p, card);
  const paymentIntentId = lastPaymentIntentId();
  const res = await deliver(paymentFailedEvent(p, paymentIntentId));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { started, paymentIntentId };
};

test("a declined test card unfreezes the bill and tells staff why, then the bill is unfrozen as FAILED", async () => {
  const p = await place();
  const { started } = await startAndDecline(p, "INSUFFICIENT_FUNDS");

  const failed = eventsNamed("bill.paymentFailed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].audience, "staff");
  assert.equal(String(failed[0].restaurantId), String(p.restaurant._id));
  const { failedAt, ...data } = failed[0].message.data;
  assert.deepEqual(data, {
    sessionId: p.sessionId,
    tableNumber: 4,
    readerName: "Bar",
    amountCents: 1450,
    reason: "INSUFFICIENT_FUNDS",
    message: "The card was declined for insufficient funds.",
  });
  assert.ok(Math.abs(Date.parse(failedAt) - Date.now()) < 5000);

  const unfrozen = eventsNamed("bill.unfrozen");
  assert.equal(unfrozen.length, 1);
  assert.equal(unfrozen[0].audience, undefined);
  assert.deepEqual(unfrozen[0].message.data, { sessionId: p.sessionId, reason: "FAILED" });
  assert.ok(published.indexOf(failed[0]) < published.indexOf(unfrozen[0]), "paymentFailed comes first");

  const bill = (await p.bill()).body;
  assert.equal(bill.session.status, "open");
  assert.equal(bill.freeze, null);
  assert.equal(bill.cardReader.state, "OFFERED");
  assert.deepEqual(bill.cardReaderPayment, {
    ...started.body,
    status: "FAILED",
    failure: { reason: "INSUFFICIENT_FUNDS", message: "The card was declined for insufficient funds." },
  });
  assert.equal("cardReaderPayment" in (await p.guestBill()).body, false);
  assert.equal(fake.captures(), 0);
  assert.equal((await p.payments()).length, 0);
});

test("a reader that loses its connection ends the attempt with its own reason", async () => {
  const p = await place();
  const started = await p.start();
  assert.equal(started.status, 200, JSON.stringify(started.body));
  fake.failReaderAction(readerOf(p), { failureCode: "terminal_reader_offline", failureMessage: "Reader is offline." });

  const res = await deliver(actionFailedEvent(p));
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const [failed] = eventsNamed("bill.paymentFailed");
  assert.equal(failed.message.data.reason, "READER_OFFLINE");
  assert.equal(failed.message.data.message, "The reader lost its connection during the payment.");
  assert.deepEqual(eventsNamed("bill.unfrozen").map((e) => e.message.data), [{ sessionId: p.sessionId, reason: "FAILED" }]);
  const bill = (await p.bill()).body;
  assert.equal(bill.session.status, "open");
  assert.equal(bill.cardReaderPayment.status, "FAILED");
  assert.deepEqual(bill.cardReaderPayment.failure, {
    reason: "READER_OFFLINE",
    message: "The reader lost its connection during the payment.",
  });
});

test("a reader that times out, or is cancelled on, says so", async () => {
  for (const [failureCode, reason, message] of [
    ["terminal_reader_timeout", "OTHER", "The reader timed out waiting for the card."],
    ["customer_canceled", "CANCELLED_ON_READER", "The payment was cancelled on the reader."],
  ]) {
    clearPublished();
    const p = await place();
    assert.equal((await p.start()).status, 200);
    fake.failReaderAction(readerOf(p), { failureCode, failureMessage: "failed" });
    assert.equal((await deliver(actionFailedEvent(p))).status, 200);
    const [failed] = eventsNamed("bill.paymentFailed");
    assert.equal(failed.message.data.reason, reason, failureCode);
    assert.equal(failed.message.data.message, message, failureCode);
  }
});

test("each declined test card ends the attempt with the contract's reason", async () => {
  for (const [card, reason] of [
    ["DECLINED", "DECLINED"],
    ["INSUFFICIENT_FUNDS", "INSUFFICIENT_FUNDS"],
    ["LOST_CARD", "LOST_OR_STOLEN_CARD"],
    ["STOLEN_CARD", "LOST_OR_STOLEN_CARD"],
    ["EXPIRED_CARD", "EXPIRED_CARD"],
    ["PROCESSING_ERROR", "PROCESSING_ERROR"],
  ]) {
    clearPublished();
    const p = await place();
    await startAndDecline(p, card);
    const failed = eventsNamed("bill.paymentFailed");
    assert.equal(failed.length, 1, card);
    assert.equal(failed[0].message.data.reason, reason, card);
    assert.equal(typeof failed[0].message.data.message, "string");
  }
});

test("a decline reported by the reader first still gives the card's reason, and Stripe's second event changes nothing", async () => {
  const p = await place();
  assert.equal((await p.start()).status, 200);
  await tap(p, "LOST_CARD");
  const paymentIntentId = lastPaymentIntentId();

  assert.equal((await deliver(actionFailedEvent(p))).status, 200);
  const afterFirst = (await p.bill()).body.cardReaderPayment;
  assert.equal((await deliver(paymentFailedEvent(p, paymentIntentId))).status, 200);

  const failed = eventsNamed("bill.paymentFailed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].message.data.reason, "LOST_OR_STOLEN_CARD");
  assert.equal(eventsNamed("bill.unfrozen").length, 1);
  assert.deepEqual((await p.bill()).body.cardReaderPayment, afterFirst);
});

test("a failure event delivered twice, concurrently, or for a bill no longer frozen for it changes nothing", async () => {
  const p = await place();
  assert.equal((await p.start()).status, 200);
  await tap(p, "DECLINED");
  const event = paymentFailedEvent(p, lastPaymentIntentId());
  const [a, b] = await Promise.all([deliver(event), deliver(event)]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const once = (await p.bill()).body;
  assert.equal((await deliver(event)).status, 200);

  assert.equal(eventsNamed("bill.paymentFailed").length, 1);
  assert.equal(eventsNamed("bill.unfrozen").length, 1);
  assert.deepEqual((await p.bill()).body, once);

  // A paid bill: a failure for its PaymentIntent arriving late changes nothing.
  const paid = await place();
  assert.equal((await paid.start()).status, 200);
  const paidIntent = lastPaymentIntentId();
  await tap(paid, "APPROVED");
  const authorized = stripeEvent(paid, "payment_intent.amount_capturable_updated", fake.paymentIntent(paidIntent));
  assert.equal((await deliver(authorized)).status, 200);
  clearPublished();
  const late = stripeEvent(paid, "payment_intent.payment_failed", {
    ...fake.paymentIntent(paidIntent),
    last_payment_error: { type: "card_error", code: "card_declined", decline_code: "generic_decline" },
  });
  assert.equal((await deliver(late)).status, 200);
  assert.equal(published.length, 0);
  const bill = (await paid.bill()).body;
  assert.equal(bill.payment.method, "CARD_READER");
  assert.equal(bill.cardReaderPayment, null);
});

const retry = (p, body = { expectedTotalCents: 1450 }) => p.asWaiter("post", "/card-reader-payment/retry", body);

test("retry with an unchanged total freezes the bill again and sends the same PaymentIntent to the same reader", async () => {
  const p = await place();
  const { started, paymentIntentId } = await startAndDecline(p);
  clearPublished();

  const res = await retry(p);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), [...CARD_READER_PAYMENT_KEYS].sort());
  assert.equal(res.body.id, started.body.id);
  assert.deepEqual(res.body.reader, started.body.reader);
  assert.equal(res.body.amountCents, 1450);
  assert.equal(res.body.status, "IN_PROGRESS");
  assert.equal(res.body.failure, null);
  assert.ok(Date.parse(res.body.startedAt) >= Date.parse(started.body.startedAt));
  assert.ok(Date.parse(res.body.expiresAt) > Date.parse(res.body.startedAt));

  assert.equal(fake.paymentIntentsCreated(), 1);
  assert.equal(fake.readerRequests(), 2);
  const processCalls = callsOf("terminal.readers.processPaymentIntent");
  assert.equal(processCalls.at(-1)[2].payment_intent, paymentIntentId);
  assert.equal(processCalls.at(-1)[1], readerOf(p));

  const bill = (await p.bill()).body;
  assert.equal(bill.session.status, "paying");
  assert.deepEqual(bill.cardReaderPayment, res.body);
  assert.deepEqual(eventsNamed("bill.frozen").map((e) => e.message.data), [{
    sessionId: p.sessionId,
    expiresAt: res.body.expiresAt,
    kind: "CARD_READER",
    readerName: "Bar",
    totalCents: 1450,
  }]);

  // The retried card goes through and pays the bill.
  await tap(p, "APPROVED");
  const authorized = stripeEvent(p, "payment_intent.amount_capturable_updated", fake.paymentIntent(paymentIntentId));
  assert.equal((await deliver(authorized)).status, 200);
  const payments = await p.payments();
  assert.equal(payments.length, 1);
  assert.equal(payments[0].amountCents, 1450);
  assert.equal(fake.captures(), 1);
  assert.equal((await p.bill()).body.cardReaderPayment, null);
});

test("after the bill changed, retry checks the new total and takes it on a new PaymentIntent", async () => {
  const p = await place();
  const { started, paymentIntentId } = await startAndDecline(p);
  // A guest orders more while the bill is open again.
  await createOrder(p.ctx, { clientOrderId: randomUUID(), tableId: String(p.table._id), items: p.items });

  const stale = await retry(p);
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, "BILL_CHANGED");
  assert.deepEqual(stale.body.details, { totalCents: 2900 });
  assert.equal((await p.bill()).body.cardReaderPayment.status, "FAILED");

  const res = await retry(p, { expectedTotalCents: 2900 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.id, started.body.id);
  assert.equal(res.body.amountCents, 2900);
  assert.equal(fake.paymentIntentsCreated(), 2);
  const newIntentId = lastPaymentIntentId();
  assert.notEqual(newIntentId, paymentIntentId);
  assert.equal(fake.paymentIntent(newIntentId).amount, 2900);
  assert.equal((await p.bill()).body.freeze.totalCents, 2900);
  // The earlier PaymentIntent, for the old total, is not left behind at Stripe.
  assert.equal(fake.paymentIntent(paymentIntentId).status, "canceled");
  assert.equal(fake.paymentIntent(newIntentId).status, "requires_payment_method");
});

test("retry makes a new PaymentIntent when Stripe can no longer use the earlier one", async () => {
  const p = await place();
  const { paymentIntentId } = await startAndDecline(p);
  fake.cancelPaymentIntent(paymentIntentId);

  const res = await retry(p);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(fake.paymentIntentsCreated(), 2);
  assert.notEqual(lastPaymentIntentId(), paymentIntentId);
  assert.equal(fake.paymentIntent(lastPaymentIntentId()).amount, 1450);
});

test("concurrent retries lead to one reader request and one freeze", async () => {
  const p = await place();
  await startAndDecline(p);
  clearPublished();

  const [a, b] = await Promise.all([retry(p), retry(p)]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.deepEqual(a.body, b.body);
  const again = await retry(p);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body, a.body);

  assert.equal(fake.readerRequests(), 2);
  assert.equal(fake.paymentIntentsCreated(), 1);
  assert.equal(eventsNamed("bill.frozen").length, 1);
});

test("a failure Stripe reported for the earlier try changes nothing once the retry runs", async () => {
  const p = await place();
  assert.equal((await p.start()).status, 200);
  await tap(p, "DECLINED");
  const paymentIntentId = lastPaymentIntentId();
  const first = paymentFailedEvent(p, paymentIntentId);
  assert.equal((await deliver(first)).status, 200);
  // Stripe dates events to the second; the retry starts in a later one.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await retry(p)).status, 200);
  clearPublished();

  // Redelivered after the retry started, on the PaymentIntent it uses again.
  assert.equal((await deliver(first)).status, 200);
  assert.equal(published.length, 0);
  assert.equal((await p.bill()).body.session.status, "paying");
});

test("retry is refused without a failed attempt, for guests, and keeps the failed attempt when Stripe fails", async () => {
  const idle = await place();
  const none = await retry(idle);
  assert.equal(none.status, 404, JSON.stringify(none.body));
  assert.equal(fake.readerRequests(), 0);

  const p = await place();
  await startAndDecline(p);
  const guest = await p.asGuest("post", "/card-reader-payment/retry", { expectedTotalCents: 1450 });
  assert.equal(guest.status, 403, JSON.stringify(guest.body));
  const invalid = await retry(p, { expectedTotalCents: "all of it" });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal(invalid.body.code, "VALIDATION");

  const failedBefore = (await p.bill()).body.cardReaderPayment;
  clearPublished();
  fake.failNext("terminal.readers.processPaymentIntent");
  const res = await retry(p);
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.code, "PAYMENT_PROVIDER_ERROR");
  const bill = (await p.bill()).body;
  assert.equal(bill.session.status, "open");
  assert.deepEqual(bill.cardReaderPayment, failedBefore);
  assert.equal(eventsNamed("bill.frozen").length, 0);

  // A new start replaces the failed attempt.
  const started = await p.start();
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.notEqual(started.body.id, failedBefore.id);
  assert.deepEqual((await p.bill()).body.cardReaderPayment, started.body);
});

test("without Stripe keys retry answers 503 STRIPE_NOT_CONFIGURED", async () => {
  const p = await place();
  await startAndDecline(p);
  setStripeClient(null);
  delete process.env.STRIPE_SECRET_KEY;
  const res = await retry(p);
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.code, "STRIPE_NOT_CONFIGURED");
});

test("declined test cards work in test mode only", async () => {
  const p = await place();
  assert.equal((await p.start()).status, 200);
  process.env.STRIPE_SECRET_KEY = "sk_live_card_reader_payment";
  const res = await p.asWaiter("post", "/card-reader-payment/test-card", { card: "DECLINED" });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "SIMULATED_READER_LIVE_MODE");
  assert.equal(callsOf("testHelpers.terminal.readers.presentPaymentMethod").length, 0);
  assert.equal((await p.bill()).body.session.status, "paying");
});
