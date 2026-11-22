process.env.JWT_SECRET = "test-secret-online-payment-webhook";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateTableToken } from "../../src/shared/auth.js";
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
import { clearPublished, published } from "../../src/realtime/events.js";
import { cardDetails, createFakeStripe } from "../support/fakeStripe.js";

const WEBHOOK_SECRET = "whsec_online_payment_test";
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_online_payment",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  DASHBOARD_URL: "https://dashboard.example.com",
  GUEST_APP_URL: "https://guest.example.com",
  STRIPE_APPLICATION_FEE_BPS: "0",
};

let replset;
let app;
let request;
let stripe;
let signed = [];

// A restaurant where a guest may pay online, with one table and an open
// session holding a pizza and a beer (14.50 €).
const fixture = async () => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({
    name: `R${suffix}`,
    slug: `r-${suffix}`,
    tse: { setupStep: "DONE", tssSerial: "serial", clientId: "client" },
    payoutAccount: { stripeAccountId: `acct_${suffix}`, chargesEnabled: true, detailsSubmitted: true },
  });
  const waiter = await Employee.create({
    restaurantId: restaurant._id,
    employee: `waiter-${suffix}`,
    email: `waiter-${suffix}@example.com`,
    password: "x".repeat(60),
    position: "waiter",
    role: "waiter",
  });
  const table = await Table.create({ restaurantId: restaurant._id, tableNumber: 1, capacity: 4 });
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
  const guestCtx = {
    restaurantId: restaurant._id,
    requestId: randomUUID(),
    actor: { type: "guest", id: null, sessionId, tableId: String(table._id) },
  };
  const start = async () => {
    const res = await request(app)
      .post(`/api/v1/sessions/${sessionId}/online-payment`)
      .set("Authorization", `Bearer ${guestToken}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const session = await TableSession.findOne({ _id: sessionId, restaurantId: restaurant._id }).lean();
    return session.paymentInProgress.checkoutSessionId;
  };
  const session = () => TableSession.findOne({ _id: sessionId, restaurantId: restaurant._id }).lean();
  const payments = () => Payment.find({ restaurantId: restaurant._id, sessionId }).lean();
    const pollReceipt = () =>
    request(app).get(`/api/v1/sessions/${sessionId}/receipt-token`).set("Authorization", `Bearer ${guestToken}`);
  return { restaurant, table, sessionId, order, ctx, guestCtx, items, start, session, payments, pollReceipt };
};

// A v1 Checkout Session event, as Stripe sends it for a direct charge on the
// restaurant's connected account.
const checkoutEvent = (place, type, checkoutSessionId, overrides = {}) => ({
  id: `evt_${randomUUID()}`,
  object: "event",
  type,
  account: place.restaurant.payoutAccount.stripeAccountId,
  livemode: false,
  created: Math.floor(Date.now() / 1000),
  data: {
    object: {
      id: checkoutSessionId,
      object: "checkout.session",
      mode: "payment",
      status: type === "checkout.session.expired" ? "expired" : "complete",
      payment_status: type === "checkout.session.expired" ? "unpaid" : "paid",
      payment_intent: type === "checkout.session.expired" ? null : `pi_${checkoutSessionId}`,
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

const completed = (place, checkoutSessionId, overrides) =>
  deliver(checkoutEvent(place, "checkout.session.completed", checkoutSessionId, overrides));
const expired = (place, checkoutSessionId) =>
  deliver(checkoutEvent(place, "checkout.session.expired", checkoutSessionId));

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
  await Payment.init();
}, { timeout: 180000 });

test.beforeEach(() => {
  Object.assign(process.env, STRIPE_ENV);
  stripe = createFakeStripe();
  setStripeClient(stripe);
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

test("completed on a frozen bill records one ONLINE Payment, reopens the session and publishes bill.paid", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  clearPublished();
  signed = [];

  const res = await completed(place, checkoutSessionId);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const payments = await place.payments();
  assert.equal(payments.length, 1);
  const [payment] = payments;
  assert.equal(payment.method, "ONLINE");
  assert.equal(payment.amountCents, 1450);
  assert.equal(payment.clientPaymentId, checkoutSessionId);
  assert.equal(payment.paidBy, undefined);
  assert.equal(String(payment.tableId), String(place.table._id));
  assert.match(payment.receiptToken, /^[0-9a-f]{32}$/);
  assert.equal(payment.tse.status, "PENDING");
  assert.deepEqual(signed.map(({ kind, id }) => ({ kind, id: String(id) })), [{ kind: "PAYMENT", id: String(payment._id) }]);

  const session = await place.session();
  assert.equal(session.status, "open");
  assert.equal(session.paymentInProgress, undefined);

  const paid = eventsNamed("bill.paid");
  assert.equal(paid.length, 1);
  // No audience: it goes to the staff room as well as the session's room.
  assert.equal(paid[0].audience, undefined);
  assert.equal(String(paid[0].restaurantId), String(place.restaurant._id));
  assert.equal(String(paid[0].sessionId), place.sessionId);
  assert.deepEqual(paid[0].message.data, {
    sessionId: place.sessionId,
    paymentId: String(payment._id),
    receiptToken: payment.receiptToken,
    method: "ONLINE",
    totalCents: 1450,
  });
});

test("the same completed event delivered twice still makes one Payment", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  const event = checkoutEvent(place, "checkout.session.completed", checkoutSessionId);
  assert.equal((await deliver(event)).status, 200);
  clearPublished();
  signed = [];
  assert.equal((await deliver(event)).status, 200);
  assert.equal((await place.payments()).length, 1);
  assert.equal(eventsNamed("bill.paid").length, 0);
  assert.deepEqual(signed, []);
});

test("after an online payment new orders and cancels get 409 BILL_PAID; the table stays open", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  assert.equal((await completed(place, checkoutSessionId)).status, 200);
  const rejects = (promise) =>
    assert.rejects(promise, (error) => {
      assert.equal(error.code, "BILL_PAID");
      assert.equal(error.status, 409);
      return true;
    });
  await rejects(createOrder(place.guestCtx, { clientOrderId: randomUUID(), items: place.items }));
  await rejects(createOrder(place.ctx, { clientOrderId: randomUUID(), sessionId: place.sessionId, items: place.items }));
  await rejects(cancelOrder(place.guestCtx, { orderId: place.order._id }));
  assert.equal((await place.session()).status, "open");
  assert.equal((await Table.findOne({ _id: place.table._id, restaurantId: place.restaurant._id }).lean()).status, "occupied");
});

test("a completed event that is not paid yet records nothing", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  const res = await completed(place, checkoutSessionId, { payment_status: "unpaid" });
  assert.equal(res.status, 200);
  assert.equal((await place.payments()).length, 0);
  assert.equal((await place.session()).status, "paying");
});

test("a late completed payment records nothing and answers 200", async () => {
  // A different Checkout Session than the one the bill is frozen for.
  const place = await fixture();
  await place.start();
  const other = await completed(place, "cs_test_someother");
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.equal((await place.payments()).length, 0);
  assert.equal((await place.session()).status, "paying");

  // The bill is not frozen at all.
  const open = await fixture();
  const res = await completed(open, "cs_test_neverstarted");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await open.payments()).length, 0);
  assert.equal((await open.session()).status, "open");

  // The session is closed.
  const closed = await fixture();
  const closedCheckout = await closed.start();
  await TableSession.updateOne({ _id: closed.sessionId, restaurantId: closed.restaurant._id }, { $set: { status: "closed", closedAt: new Date() } });
  const late = await completed(closed, closedCheckout);
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal((await closed.payments()).length, 0);

  // A session that does not exist, or of another restaurant.
  const strange = await completed(place, "cs_test_x", {
    metadata: { restaurantId: String(open.restaurant._id), sessionId: place.sessionId },
  });
  assert.equal(strange.status, 200, JSON.stringify(strange.body));
  assert.equal(eventsNamed("bill.paid").length, 0);
});

test("expired on a frozen bill unfreezes it and publishes bill.unfrozen", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  clearPublished();
  const res = await expired(place, checkoutSessionId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const session = await place.session();
  assert.equal(session.status, "open");
  assert.equal(session.paymentInProgress, undefined);
  const unfrozen = eventsNamed("bill.unfrozen");
  assert.equal(unfrozen.length, 1);
  assert.equal(unfrozen[0].audience, undefined);
  assert.equal(String(unfrozen[0].sessionId), place.sessionId);
  assert.deepEqual(unfrozen[0].message.data, { sessionId: place.sessionId });

  // The guest can order again.
  await createOrder(place.guestCtx, { clientOrderId: randomUUID(), items: place.items });
});

test("expired for an old or other Checkout Session changes nothing", async () => {
  const place = await fixture();
  await place.start();
  clearPublished();
  const res = await expired(place, "cs_test_old");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await place.session()).status, "paying");
  assert.equal(eventsNamed("bill.unfrozen").length, 0);

  const open = await fixture();
  assert.equal((await expired(open, "cs_test_old")).status, 200);
  assert.equal((await open.session()).status, "open");
  assert.equal(eventsNamed("bill.unfrozen").length, 0);
});

test("expired after the completed event changes nothing", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  assert.equal((await completed(place, checkoutSessionId)).status, 200);
  clearPublished();
  assert.equal((await expired(place, checkoutSessionId)).status, 200);
  assert.equal(eventsNamed("bill.unfrozen").length, 0);
  assert.equal((await place.payments()).length, 1);
});

test("the guest polls for the receipt and the webhook never came: Stripe is asked and the Payment recorded", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();

  const waiting = await place.pollReceipt();
  assert.equal(waiting.status, 202, JSON.stringify(waiting.body));
  assert.equal((await place.payments()).length, 0);

  stripe.completeCheckoutSession(checkoutSessionId);
  clearPublished();
  const res = await place.pollReceipt();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [payment] = await place.payments();
  assert.equal(payment.method, "ONLINE");
  assert.equal(payment.clientPaymentId, checkoutSessionId);
  assert.equal(payment.amountCents, 1450);
  assert.deepEqual(res.body, { receiptToken: payment.receiptToken });
  assert.equal((await place.session()).status, "open");
  assert.equal(eventsNamed("bill.paid").length, 1);

  // The webhook arriving later replays: still one Payment.
  assert.equal((await completed(place, checkoutSessionId)).status, 200);
  assert.equal((await place.payments()).length, 1);
});

test("a card payment keeps brand, last 4, funding, wallet, authorization code and the PaymentIntent", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  stripe.completeCheckoutSession(checkoutSessionId, cardDetails({ brand: "mastercard", last4: "1234", funding: "debit", wallet: "apple_pay" }));

  assert.equal((await completed(place, checkoutSessionId)).status, 200);

  const [payment] = await place.payments();
  assert.match(payment.card.paymentIntentId, /^pi_/);
  assert.deepEqual(
    { ...payment.card, paymentIntentId: undefined },
    {
      type: "card",
      brand: "mastercard",
      last4: "1234",
      funding: "debit",
      wallet: "apple_pay",
      authorizationCode: "123456",
      paymentIntentId: undefined,
      authorizedAt: new Date(1794000000 * 1000),
    }
  );
  const retrieve = stripe.calls.find(([op, , params]) => op === "checkout.sessions.retrieve" && params?.expand);
  assert.deepEqual(retrieve[2], { expand: ["payment_intent.latest_charge"] });
  assert.deepEqual(retrieve[3], { stripeAccount: place.restaurant.payoutAccount.stripeAccountId });
});

test("a payment that is not by card keeps only its type, the PaymentIntent and the time", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  stripe.completeCheckoutSession(checkoutSessionId, { type: "paypal", paypal: { payer_email: "guest@example.com" } });

  assert.equal((await completed(place, checkoutSessionId)).status, 200);

  const [payment] = await place.payments();
  assert.deepEqual(Object.keys(payment.card).sort(), ["authorizedAt", "paymentIntentId", "type"]);
  assert.equal(payment.card.type, "paypal");
});

test("Stripe failing to give the details still records the payment; a redelivered event fills them in", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  stripe.completeCheckoutSession(checkoutSessionId);
  stripe.failNext("checkout.sessions.retrieve");

  assert.equal((await completed(place, checkoutSessionId)).status, 200);
  let [payment] = await place.payments();
  assert.equal(payment.method, "ONLINE");
  assert.equal(payment.card, undefined);

  assert.equal((await completed(place, checkoutSessionId)).status, 200);
  [payment] = await place.payments();
  assert.equal((await place.payments()).length, 1);
  assert.equal(payment.card.type, "card");
  assert.equal(payment.card.last4, "4242");
});
