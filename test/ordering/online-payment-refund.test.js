process.env.JWT_SECRET = "test-secret-online-payment-refund";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateTableToken, generateToken } from "../../src/shared/auth.js";
import { createOrder } from "../../src/modules/ordering/order.service.js";
import TableSession from "../../src/modules/ordering/session.model.js";
import Payment from "../../src/modules/payments/payment.model.js";
import OnlinePaymentRefund from "../../src/modules/payments/onlinePaymentRefund.model.js";
import { recordPayment } from "../../src/modules/payments/payment.service.js";
import { signing } from "../../src/modules/payments/signing.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";
import { setStripeClient } from "../../src/modules/payouts/stripe.js";
import { clearPublished, published } from "../../src/realtime/events.js";
import { createFakeStripe } from "../support/fakeStripe.js";

const WEBHOOK_SECRET = "whsec_online_payment_refund_test";
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_online_payment_refund",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  DASHBOARD_URL: "https://dashboard.example.com",
  GUEST_APP_URL: "https://guest.example.com",
  STRIPE_APPLICATION_FEE_BPS: "0",
};

let replset;
let app;
let request;
let stripe;

const staffOf = (restaurant, position) =>
  Employee.create({
    restaurantId: restaurant._id,
    employee: `${position}-${randomUUID().slice(0, 8)}`,
    email: `${position}-${randomUUID().slice(0, 8)}@example.com`,
    password: "x".repeat(60),
    position,
    role: position === "bar" ? "staff" : position,
  });

// A restaurant where a guest may pay online, with table 7 and an open session
// holding a pizza and a beer (14.50 €).
const fixture = async () => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({
    name: `R${suffix}`,
    slug: `r-${suffix}`,
    tse: { setupStep: "DONE", tssSerial: "serial", clientId: "client" },
    payoutAccount: { stripeAccountId: `acct_${suffix}`, chargesEnabled: true, detailsSubmitted: true },
  });
  const waiter = await staffOf(restaurant, "waiter");
  const table = await Table.create({ restaurantId: restaurant._id, tableNumber: 7, capacity: 4 });
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
  const start = async () => {
    const res = await request(app)
      .post(`/api/v1/sessions/${sessionId}/online-payment`)
      .set("Authorization", `Bearer ${guestToken}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const session = await TableSession.findOne({ _id: sessionId, restaurantId: restaurant._id }).lean();
    return session.onlinePayment.checkoutSessionId;
  };
  const payCash = () =>
    recordPayment(ctx, sessionId, { method: "CASH", clientPaymentId: randomUUID(), expectedTotalCents: 1450 });
  const close = () =>
    TableSession.updateOne(
      { _id: sessionId, restaurantId: restaurant._id },
      { $set: { status: "closed", closedAt: new Date() } }
    );
  const payments = () => Payment.find({ restaurantId: restaurant._id, sessionId }).lean();
  const refunds = () => OnlinePaymentRefund.find({ restaurantId: restaurant._id }).lean();
  return { restaurant, table, sessionId, guestToken, start, payCash, close, payments, refunds };
};

const checkoutEvent = (place, checkoutSessionId, overrides = {}) => ({
  id: `evt_${randomUUID()}`,
  object: "event",
  type: "checkout.session.completed",
  account: place.restaurant.payoutAccount.stripeAccountId,
  livemode: false,
  created: Math.floor(Date.now() / 1000),
  data: {
    object: {
      id: checkoutSessionId,
      object: "checkout.session",
      mode: "payment",
      status: "complete",
      payment_status: "paid",
      payment_intent: `pi_${checkoutSessionId}`,
      amount_total: 1450,
      currency: "eur",
      metadata: { restaurantId: String(place.restaurant._id), sessionId: place.sessionId, amountCents: "1450" },
      ...overrides,
    },
  },
});

const deliver = (event) => {
  const { body, signature } = stripe.signedEvent(event, WEBHOOK_SECRET);
  return request(app)
    .post("/api/v1/webhooks/stripe")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", signature)
    .send(body);
};

const refundCalls = () => stripe.calls.filter(([op]) => op === "refunds.create");
const eventsNamed = (name) => published.filter((envelope) => envelope.message?.event === name);

const realRequestSigning = signing.requestSigning;

test.before(async () => {
  signing.requestSigning = async () => {};
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_DB_URL = replset.getUri();
  await connectToDatabase();
  ({ default: request } = await import("supertest"));
  ({ default: app } = await import("../../src/app.js"));
  await Payment.init();
  await OnlinePaymentRefund.init();
}, { timeout: 180000 });

test.beforeEach(() => {
  Object.assign(process.env, STRIPE_ENV);
  stripe = createFakeStripe();
  setStripeClient(stripe);
  clearPublished();
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

// Delivers a late completed event for `checkoutSessionId` and checks the one
// refund, the one record, the event, and that no ONLINE Payment exists.
const assertRefunded = async (place, checkoutSessionId, reason) => {
  const res = await deliver(checkoutEvent(place, checkoutSessionId));
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const calls = refundCalls();
  assert.equal(calls.length, 1);
  const [, params, options] = calls[0];
  assert.deepEqual(params, { payment_intent: `pi_${checkoutSessionId}`, refund_application_fee: true });
  assert.deepEqual(options, {
    stripeAccount: place.restaurant.payoutAccount.stripeAccountId,
    idempotencyKey: checkoutSessionId,
  });

  const records = await place.refunds();
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(String(record.sessionId), place.sessionId);
  assert.equal(String(record.tableId), String(place.table._id));
  assert.equal(record.tableNumber, 7);
  assert.equal(record.checkoutSessionId, checkoutSessionId);
  assert.equal(record.paymentIntentId, `pi_${checkoutSessionId}`);
  assert.equal(record.amountCents, 1450);
  assert.equal(record.reason, reason);
  assert.ok(record.refundedAt instanceof Date);

  const online = (await place.payments()).filter((payment) => payment.method === "ONLINE");
  assert.deepEqual(online, []);

  const refunded = eventsNamed("online_payment.refunded");
  assert.equal(refunded.length, 1);
  assert.equal(refunded[0].audience, "staff");
  assert.equal(String(refunded[0].restaurantId), String(place.restaurant._id));
  assert.deepEqual(refunded[0].message.data, {
    refund: {
      id: String(record._id),
      sessionId: place.sessionId,
      tableNumber: 7,
      amountCents: 1450,
      reason,
      refundedAt: record.refundedAt.toISOString(),
    },
  });
  return record;
};

test("a completed payment for a bill staff already paid is refunded as BILL_ALREADY_PAID", async () => {
  const place = await fixture();
  await place.payCash();
  await assertRefunded(place, "cs_test_afterCash", "BILL_ALREADY_PAID");
  assert.equal((await place.payments()).length, 1);
});

test("a completed payment for a bill that is not frozen for it is refunded as BILL_NOT_FROZEN", async () => {
  const place = await fixture();
  await assertRefunded(place, "cs_test_neverFrozen", "BILL_NOT_FROZEN");
  assert.equal((await TableSession.findById(place.sessionId).setOptions({ skipTenant: true }).lean()).status, "open");
});

test("a completed payment for another Checkout Session than the frozen one is refunded as BILL_NOT_FROZEN", async () => {
  const place = await fixture();
  await place.start();
  await assertRefunded(place, "cs_test_other", "BILL_NOT_FROZEN");
  assert.equal(
    (await TableSession.findOne({ _id: place.sessionId, restaurantId: place.restaurant._id }).lean()).status,
    "paying"
  );
});

test("a completed payment for a closed session is refunded as SESSION_CLOSED", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  await place.close();
  await assertRefunded(place, checkoutSessionId, "SESSION_CLOSED");
});

test("a redelivered late event refunds once and records once", async () => {
  const place = await fixture();
  await place.payCash();
  const event = checkoutEvent(place, "cs_test_twice");
  assert.equal((await deliver(event)).status, 200);
  clearPublished();
  assert.equal((await deliver(event)).status, 200);
  assert.equal((await deliver(checkoutEvent(place, "cs_test_twice"))).status, 200);
  assert.equal(stripe.refundsCreated(), 1);
  assert.equal((await place.refunds()).length, 1);
  assert.equal(eventsNamed("online_payment.refunded").length, 0);
});

test("a failed refund answers 500 and records nothing; the next delivery refunds", async () => {
  const place = await fixture();
  await place.payCash();
  const event = checkoutEvent(place, "cs_test_retry");
  stripe.failNext("refunds.create");
  const failed = await deliver(event);
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.equal((await place.refunds()).length, 0);
  assert.equal(stripe.refundsCreated(), 0);
  assert.equal(eventsNamed("online_payment.refunded").length, 0);

  const retried = await deliver(event);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(stripe.refundsCreated(), 1);
  assert.equal((await place.refunds()).length, 1);
  assert.equal(eventsNamed("online_payment.refunded").length, 1);
  for (const [, , options] of refundCalls()) assert.equal(options.idempotencyKey, "cs_test_retry");
});

test("an on-time completed payment is not refunded", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  assert.equal((await deliver(checkoutEvent(place, checkoutSessionId))).status, 200);
  assert.equal(refundCalls().length, 0);
  assert.equal((await place.refunds()).length, 0);
  assert.equal((await place.payments()).length, 1);
});

const list = (token, query = "") =>
  request(app).get(`/api/v1/restaurant/online-payment-refunds${query}`).set("Authorization", `Bearer ${token}`);

test("owner and admin list refunds newest first; bar, kitchen and guest get 403", async () => {
  const place = await fixture();
  await place.payCash();
  const older = new Date("2026-11-01T10:00:00.000Z");
  const newer = new Date("2026-11-02T10:00:00.000Z");
  const base = {
    restaurantId: place.restaurant._id,
    sessionId: place.sessionId,
    tableId: place.table._id,
    tableNumber: 7,
    amountCents: 1450,
    reason: "BILL_ALREADY_PAID",
  };
  const a = await OnlinePaymentRefund.create({ ...base, checkoutSessionId: "cs_a", paymentIntentId: "pi_a", refundedAt: older });
  const b = await OnlinePaymentRefund.create({ ...base, checkoutSessionId: "cs_b", paymentIntentId: "pi_b", refundedAt: newer });
  // Another restaurant's refund never shows.
  const other = await fixture();
  await OnlinePaymentRefund.create({
    ...base, restaurantId: other.restaurant._id, checkoutSessionId: "cs_c", paymentIntentId: "pi_c", refundedAt: newer,
  });

  const owner = generateToken(await staffOf(place.restaurant, "owner"));
  const admin = generateToken(await staffOf(place.restaurant, "admin"));
  const item = (doc) => ({
    id: String(doc._id),
    sessionId: place.sessionId,
    tableNumber: 7,
    amountCents: 1450,
    reason: "BILL_ALREADY_PAID",
    refundedAt: doc.refundedAt.toISOString(),
  });

  for (const token of [owner, admin]) {
    const res = await list(token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { items: [item(b), item(a)], nextBefore: null });
  }

  const first = await list(owner, "?limit=1");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { items: [item(b)], nextBefore: newer.toISOString() });
  const second = await list(owner, `?limit=1&before=${encodeURIComponent(first.body.nextBefore)}`);
  assert.deepEqual(second.body.items, [item(a)]);
  const third = await list(owner, `?limit=1&before=${encodeURIComponent(second.body.nextBefore)}`);
  assert.deepEqual(third.body, { items: [], nextBefore: null });

  for (const query of ["?limit=0", "?limit=101", "?limit=x", "?before=yesterday"]) {
    assert.equal((await list(owner, query)).status, 400, query);
  }

  for (const position of ["bar", "kitchen"]) {
    assert.equal((await list(generateToken(await staffOf(place.restaurant, position)))).status, 403, position);
  }
  assert.equal((await list(place.guestToken)).status, 403);
});
