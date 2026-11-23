process.env.JWT_SECRET = "test-secret-card-reader-payment-end";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

// How a card reader payment ends without the card going through: cancel,
// expiry, and staff recording cash, Card Terminal or closing the table. In
// every case the reader is cleared, the authorization is released, and a
// card that still goes through is never captured (ADR-0008).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateTableToken, generateToken, hashPassword } from "../../src/shared/auth.js";
import { createOrder } from "../../src/modules/ordering/order.service.js";
import Payment from "../../src/modules/payments/payment.model.js";
import TableSession from "../../src/modules/ordering/session.model.js";
import { createCardReaderExpirySweep } from "../../src/jobs/cardReaderExpirySweep.js";
import OnlinePaymentRefund from "../../src/modules/payments/onlinePaymentRefund.model.js";
import { signing } from "../../src/modules/payments/signing.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";
import { setStripeClient } from "../../src/modules/payouts/stripe.js";
import { clearPublished, published } from "../../src/realtime/events.js";
import { createFakeStripe } from "../support/fakeStripe.js";

const WEBHOOK_SECRET = "whsec_card_reader_payment_end_test";
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_card_reader_payment_end",
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

let replset;
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
    role: position === "bar" || position === "kitchen" ? "staff" : position,
  });

// A restaurant that can take card reader payments, with a Simulated Reader
// named "Bar" and one table with an open bill of 14.50 €.
const place = async () => {
  const suffix = randomUUID().slice(0, 8);
  const stripeAccountId = `acct_${suffix}`;
  const restaurant = await Restaurant.create({
    name: `R${suffix}`,
    slug: `r-${suffix}`,
    legal: LEGAL,
    tse: { setupStep: "DONE", tssSerial: "serial", clientId: "client" },
    payoutAccount: { stripeAccountId, chargesEnabled: true, detailsSubmitted: true },
  });
  const owner = await staffOf(restaurant, "owner");
  const waiter = await staffOf(restaurant, "waiter");
  const ownerToken = generateToken(owner);
  const waiterToken = generateToken(waiter);
  const barToken = generateToken(await staffOf(restaurant, "bar"));

  const added = await request(app)
    .post("/api/v1/restaurant/card-readers/simulated")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: "Bar" });
  assert.equal(added.status, 201, JSON.stringify(added.body));

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
    sessionId,
    asWaiter,
    asBar: as(barToken),
    asOwner: as(ownerToken),
    asGuest: as(guestToken),
    start: () => asWaiter("post", "/card-reader-payment", { readerId: added.body.id, expectedTotalCents: 1450 }),
    cancel: (asStaff = asWaiter) => asStaff("post", "/card-reader-payment/cancel"),
    pay: (method = "CASH") =>
      asWaiter("post", "/payments", { method, clientPaymentId: randomUUID(), expectedTotalCents: 1450 }),
    bill: () => asWaiter("get", "/bill"),
    payments: () => Payment.find({ restaurantId: restaurant._id, sessionId }).lean(),
    latePayments: () => OnlinePaymentRefund.find({ restaurantId: restaurant._id }).lean(),
  };
};

const callsOf = (op) => fake.calls.filter(([name]) => name === op);
const eventsNamed = (name) => published.filter((envelope) => envelope.message?.event === name);
const eventOrder = () => published.map((envelope) => envelope.message?.event);

// The webhook Stripe sends once the card is authorized on the reader.
const authorizedEvent = (p, paymentIntentId) => ({
  id: `evt_${randomUUID()}`,
  object: "event",
  type: "payment_intent.amount_capturable_updated",
  account: p.stripeAccountId,
  livemode: false,
  created: Math.floor(Date.now() / 1000),
  data: { object: fake.paymentIntent(paymentIntentId) },
});

const deliver = (event) => {
  const { body, signature } = fake.signedEvent(event, WEBHOOK_SECRET);
  return request(app)
    .post("/api/v1/webhooks/stripe")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", signature)
    .send(body);
};

// Starts on the Simulated Reader; returns the reader's and the PaymentIntent's Stripe ids.
const started = async (p) => {
  const res = await p.start();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [[, stripeReaderId, params]] = callsOf("terminal.readers.processPaymentIntent");
  return { attempt: res.body, stripeReaderId, paymentIntentId: params.payment_intent };
};

// The reader no longer asks for a card, and the PaymentIntent can never be captured.
const assertReleased = ({ stripeReaderId, paymentIntentId }) => {
  assert.notEqual(fake.reader(stripeReaderId).action?.status, "in_progress", "the reader still asks for the card");
  assert.equal(fake.paymentIntent(paymentIntentId).status, "canceled");
};

const assertUnfrozen = async (p, reason) => {
  const bill = (await p.bill()).body;
  assert.equal(bill.session.status, "open");
  assert.equal(bill.freeze, null);
  assert.equal(bill.cardReaderPayment, null);
  const unfrozen = eventsNamed("bill.unfrozen");
  assert.equal(unfrozen.length, 1);
  assert.equal(String(unfrozen[0].sessionId), p.sessionId);
  assert.equal(unfrozen[0].audience, undefined);
  assert.deepEqual(unfrozen[0].message.data, { sessionId: p.sessionId, reason });
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
  fake = createFakeStripe();
  setStripeClient(fake);
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

test("cancel clears the reader's request, releases the PaymentIntent, unfreezes the bill and publishes unfrozen with reason CANCELLED", async () => {
  const p = await place();
  const attempt = await started(p);

  const res = await p.cancel();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { status: "open" });

  assertReleased(attempt);
  await assertUnfrozen(p, "CANCELLED");
  for (const op of ["terminal.readers.cancelAction", "paymentIntents.cancel"]) {
    const [call] = callsOf(op);
    assert.ok(call, `${op} was called`);
    assert.equal(call.at(-1).stripeAccount, p.stripeAccountId);
  }
});

test("cancelling twice, or with nothing in progress, answers the session's status and changes nothing more", async () => {
  const idle = await place();
  const nothing = await idle.cancel();
  assert.equal(nothing.status, 200, JSON.stringify(nothing.body));
  assert.deepEqual(nothing.body, { status: "open" });
  assert.equal(eventsNamed("bill.unfrozen").length, 0);

  const p = await place();
  await started(p);
  const [first, second] = await Promise.all([p.cancel(), p.cancel(p.asBar)]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const third = await p.cancel(p.asOwner);
  assert.deepEqual([first.body, second.body, third.body], [{ status: "open" }, { status: "open" }, { status: "open" }]);
  await assertUnfrozen(p, "CANCELLED");
  assert.equal(callsOf("paymentIntents.cancel").length, 1);

  const guest = await p.asGuest("post", "/card-reader-payment/cancel");
  assert.equal(guest.status, 403, JSON.stringify(guest.body));
});

test("cancelling after the card went through answers BILL_PAID and releases nothing", async () => {
  const p = await place();
  const { paymentIntentId } = await started(p);
  assert.equal((await p.asWaiter("post", "/card-reader-payment/test-card", { card: "APPROVED" })).status, 200);
  assert.equal((await deliver(authorizedEvent(p, paymentIntentId))).status, 200);
  clearPublished();

  const res = await p.cancel();
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "BILL_PAID");
  assert.equal(fake.paymentIntent(paymentIntentId).status, "succeeded");
  assert.equal(callsOf("paymentIntents.cancel").length, 0);
  assert.equal(eventsNamed("bill.unfrozen").length, 0);
  assert.equal((await p.payments()).length, 1);
});

// The card is read after the bill stopped waiting for it (the reader could
// not be cleared): Stripe authorizes it and sends the webhook.
const tapLate = async (p, stripeReaderId, paymentIntentId) => {
  await fake.testHelpers.terminal.readers.presentPaymentMethod(
    stripeReaderId,
    { type: "card_present", card_present: { number: "4242424242424242" } },
    { stripeAccount: p.stripeAccountId }
  );
  assert.equal(fake.paymentIntent(paymentIntentId).status, "requires_capture");
  const res = await deliver(authorizedEvent(p, paymentIntentId));
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

// Released, never captured: no Payment, no Late Payment.
const assertNeverCaptured = async (p, paymentIntentId) => {
  assert.equal(fake.captures(), 0);
  assert.equal(callsOf("paymentIntents.capture").length, 0);
  assert.equal(fake.paymentIntent(paymentIntentId).status, "canceled");
  assert.equal((await p.payments()).filter((payment) => payment.method === "CARD_READER").length, 0);
  assert.equal((await p.latePayments()).length, 0);
  assert.equal(eventsNamed("bill.paid").filter((e) => e.message.data.method === "CARD_READER").length, 0);
};

test("cancel unfreezes even when Stripe is down, and a card authorized afterwards is cancelled at Stripe, never captured", async () => {
  const p = await place();
  const { stripeReaderId, paymentIntentId } = await started(p);

  fake.setDown(true);
  const res = await p.cancel();
  fake.setDown(false);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { status: "open" });
  await assertUnfrozen(p, "CANCELLED");

  await tapLate(p, stripeReaderId, paymentIntentId);
  await assertNeverCaptured(p, paymentIntentId);
  assert.equal((await p.bill()).body.session.status, "open");
});

for (const method of ["CASH", "CARD_TERMINAL"]) {
  test(`${method} during a card reader payment clears the reader, releases the PaymentIntent, and publishes unfrozen with reason STAFF_PAYMENT before paid`, async () => {
    const p = await place();
    const attempt = await started(p);

    const res = await p.pay(method);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.method, method);

    assertReleased(attempt);
    await assertUnfrozen(p, "STAFF_PAYMENT");
    assert.deepEqual(eventOrder().filter((name) => name.startsWith("bill.")), ["bill.frozen", "bill.unfrozen", "bill.paid"]);
    const bill = (await p.bill()).body;
    assert.equal(bill.payment.method, method);
  });

  test(`${method} during a card reader payment succeeds when Stripe is down, and the card tapped afterwards is never captured`, async () => {
    const p = await place();
    const { stripeReaderId, paymentIntentId } = await started(p);

    fake.setDown(true);
    const res = await p.pay(method);
    fake.setDown(false);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await assertUnfrozen(p, "STAFF_PAYMENT");

    await tapLate(p, stripeReaderId, paymentIntentId);
    await assertNeverCaptured(p, paymentIntentId);
    const payments = await p.payments();
    assert.deepEqual(payments.map((payment) => payment.method), [method]);
  });
}

test("closing the table during a card reader payment releases it with reason STAFF_PAYMENT; a close that would be unpaid fails first and leaves the reader alone", async () => {
  const p = await place();
  const attempt = await started(p);

  const unpaid = await p.asWaiter("post", "/close", {});
  assert.equal(unpaid.status, 409, JSON.stringify(unpaid.body));
  assert.equal(unpaid.body.code, "BILL_UNPAID");
  assert.equal(fake.paymentIntent(attempt.paymentIntentId).status, "requires_payment_method");
  assert.equal(fake.reader(attempt.stripeReaderId).action.status, "in_progress");
  assert.equal((await p.bill()).body.session.status, "paying");

  const closed = await p.asOwner("post", "/close", { unpaidReason: "Guest left" });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.status, "closed");
  assertReleased(attempt);
  const unfrozen = eventsNamed("bill.unfrozen");
  assert.deepEqual(unfrozen.map((e) => e.message.data), [{ sessionId: p.sessionId, reason: "STAFF_PAYMENT" }]);
  assert.deepEqual(eventOrder().filter((name) => name === "bill.unfrozen" || name === "session.closed"), ["bill.unfrozen", "session.closed"]);
});

test("the sweep ends card reader payments older than 3 minutes with reason EXPIRED and leaves younger ones running", async () => {
  const old = await place();
  const oldAttempt = await started(old);
  fake.calls.length = 0;
  const young = await place();
  const youngAttempt = await started(young);
  clearPublished();

  const now = new Date(Date.parse(oldAttempt.attempt.startedAt) + 3 * 60 * 1000 + 1);
  await TableSession.updateOne(
    { _id: young.sessionId, restaurantId: young.restaurant._id },
    { $set: { "paymentInProgress.expiresAt": new Date(now.getTime() + 60 * 1000) } }
  );
  await createCardReaderExpirySweep({ now: () => now }).runOnce();

  assertReleased(oldAttempt);
  await assertUnfrozen(old, "EXPIRED");
  assert.equal((await young.bill()).body.session.status, "paying");
  assert.equal(fake.reader(youngAttempt.stripeReaderId).action.status, "in_progress");
  assert.notEqual(fake.paymentIntent(youngAttempt.paymentIntentId).status, "canceled");

});

test("a card authorized after the payment expired, with Stripe down at expiry, is cancelled and never captured", async () => {
  const p = await place();
  const { attempt, stripeReaderId, paymentIntentId } = await started(p);

  fake.setDown(true);
  await createCardReaderExpirySweep({ now: () => new Date(Date.parse(attempt.expiresAt) + 1) }).runOnce();
  fake.setDown(false);
  await assertUnfrozen(p, "EXPIRED");

  await tapLate(p, stripeReaderId, paymentIntentId);
  await assertNeverCaptured(p, paymentIntentId);
});
