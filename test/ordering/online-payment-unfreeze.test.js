process.env.JWT_SECRET = "test-secret-online-payment-unfreeze";
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
import { signing } from "../../src/modules/payments/signing.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";
import { setStripeClient } from "../../src/modules/payouts/stripe.js";
import { clearPublished, published } from "../../src/realtime/events.js";
import { createFakeStripe } from "../support/fakeStripe.js";

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_online_payment",
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
    role: position,
  });

// A restaurant where a guest may pay online, with one table and an open
// session holding a pizza and a beer (14.50 €), and one of each kind of staff.
const fixture = async () => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({
    name: `R${suffix}`,
    slug: `r-${suffix}`,
    tse: { setupStep: "DONE", tssSerial: "serial", clientId: "client" },
    payoutAccount: { stripeAccountId: `acct_${suffix}`, chargesEnabled: true, detailsSubmitted: true },
  });
  const staff = {};
  for (const position of ["owner", "admin", "waiter", "kitchen", "staff"]) {
    staff[position] = generateToken(await staffOf(restaurant, position));
  }
  const waiter = await Employee.findOne({ restaurantId: restaurant._id, position: "waiter" });
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
    actor: { type: "employee", id: waiter._id, position: "waiter" },
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
  const post = (path, token, body = {}) =>
    request(app).post(`/api/v1/sessions/${sessionId}${path}`).set("Authorization", `Bearer ${token}`).send(body);
  // The guest starts paying online; returns Stripe's Checkout Session id.
  const start = async () => {
    const res = await post("/online-payment", guestToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return (await session()).paymentInProgress.checkoutSessionId;
  };
  const session = () => TableSession.findOne({ _id: sessionId, restaurantId: restaurant._id }).lean();
  const payments = () => Payment.find({ restaurantId: restaurant._id, sessionId }).lean();
  return {
    restaurant,
    table,
    sessionId,
    guestCtx,
    items,
    staff,
    guestToken,
    cancel: (token = guestToken) => post("/online-payment/cancel", token),
    pay: (token = staff.waiter, body = {}) =>
      post("/payments", token, { method: "CASH", clientPaymentId: randomUUID(), expectedTotalCents: 1450, ...body }),
    close: (token, body) => post("/close", token, body),
    start,
    session,
    payments,
  };
};

const expireCalls = () => stripe.calls.filter(([op]) => op === "checkout.sessions.expire");
const eventsNamed = (name) => published.filter((envelope) => envelope.message?.event === name);

// The Checkout Session was expired on the restaurant's Payout Account.
const assertExpired = (place, checkoutSessionId) => {
  const calls = expireCalls();
  assert.equal(calls.length, 1);
  const [, id, , options] = calls[0];
  assert.equal(id, checkoutSessionId);
  assert.equal(options.stripeAccount, place.restaurant.payoutAccount.stripeAccountId);
};

const assertUnfrozen = async (place, reason) => {
  const session = await place.session();
  assert.equal(session.status, "open");
  assert.equal(session.paymentInProgress, undefined);
  const unfrozen = eventsNamed("bill.unfrozen");
  assert.equal(unfrozen.length, 1);
  assert.equal(String(unfrozen[0].sessionId), place.sessionId);
  assert.deepEqual(unfrozen[0].message.data, { sessionId: place.sessionId, reason });
};

const realRequestSigning = signing.requestSigning;

test.before(async () => {
  signing.requestSigning = async () => {};
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

test("the guest goes back from Stripe: the Checkout Session is expired, the bill opens and takes orders", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  clearPublished();

  const res = await place.cancel();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "open");
  assertExpired(place, checkoutSessionId);
  await assertUnfrozen(place, "CANCELLED");

  await createOrder(place.guestCtx, { clientOrderId: randomUUID(), items: place.items });
});

test("cancel on a bill that is not frozen is a 200 no-op", async () => {
  const place = await fixture();
  const res = await place.cancel();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, "open");
  assert.equal(expireCalls().length, 0);
  assert.equal(eventsNamed("bill.unfrozen").length, 0);
});

test("owner and admin unfreeze by hand; waiter, bar and kitchen get 403; a guest of another session 404", async () => {
  for (const who of ["owner", "admin"]) {
    const place = await fixture();
    const checkoutSessionId = await place.start();
    clearPublished();
    stripe.calls.length = 0;
    const res = await place.cancel(place.staff[who]);
    assert.equal(res.status, 200, `${who}: ${JSON.stringify(res.body)}`);
    assertExpired(place, checkoutSessionId);
    await assertUnfrozen(place, "CANCELLED");
  }

  const place = await fixture();
  await place.start();
  stripe.calls.length = 0;
  for (const who of ["waiter", "kitchen", "staff"]) {
    const res = await place.cancel(place.staff[who]);
    assert.equal(res.status, 403, who);
  }
  const other = await fixture();
  const res = await place.cancel(other.guestToken);
  assert.equal(res.status, 404);
  assert.equal(expireCalls().length, 0);
  assert.equal((await place.session()).status, "paying");
});

test("cash on a frozen bill expires the Checkout Session, then records the Payment", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  clearPublished();

  const res = await place.pay();
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assertExpired(place, checkoutSessionId);
  const payments = await place.payments();
  assert.equal(payments.length, 1);
  assert.equal(payments[0].method, "CASH");
  assert.equal(payments[0].amountCents, 1450);
  await assertUnfrozen(place, "STAFF_PAYMENT");
  // Unfrozen before paid.
  const order = published.map((envelope) => envelope.message?.event).filter((name) => name?.startsWith("bill."));
  assert.deepEqual(order, ["bill.unfrozen", "bill.paid"]);
});

test("the guest has just paid but no webhook came: unfreeze, cash and close record the online Payment from Stripe", async () => {
  const attempts = [
    ["guest cancel", (place) => place.cancel(), 200],
    ["owner unfreeze", (place) => place.cancel(place.staff.owner), 200],
    // The bill is paid online, so cash is refused.
    ["cash", (place) => place.pay(), 409, "BILL_PAID"],
    ["waiter close", (place) => place.close(place.staff.waiter), 200],
  ];
  for (const [name, attempt, status, code] of attempts) {
    const place = await fixture();
    const checkoutSessionId = await place.start();
    stripe.completeCheckoutSession(checkoutSessionId);
    clearPublished();

    const res = await attempt(place);
    assert.equal(res.status, status, `${name}: ${JSON.stringify(res.body)}`);
    if (code) assert.equal(res.body.code, code, name);
    const payments = await place.payments();
    assert.equal(payments.length, 1, name);
    assert.equal(payments[0].method, "ONLINE", name);
    assert.equal(payments[0].clientPaymentId, checkoutSessionId, name);
    assert.equal(payments[0].amountCents, 1450, name);
    assert.notEqual((await place.session()).status, "paying", name);
    assert.equal(eventsNamed("bill.paid").length, 1, name);
    assert.equal(eventsNamed("bill.unfrozen").length, 0, name);
  }
});

test("the guest has just paid but Stripe cannot be read: 409 BILL_PAYING_ONLINE and the bill stays frozen", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  stripe.completeCheckoutSession(checkoutSessionId);
  clearPublished();
  // expire fails as completed, its retrieve answers, then the record's retrieve fails.
  const real = stripe.checkout.sessions.retrieve;
  let reads = 0;
  stripe.checkout.sessions.retrieve = async (...args) => {
    reads += 1;
    if (reads > 1) throw Object.assign(new Error("down"), { type: "StripeAPIError" });
    return real(...args);
  };
  const res = await place.cancel();
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "BILL_PAYING_ONLINE");
  assert.equal((await place.session()).status, "paying");
  assert.equal((await place.payments()).length, 0);
});

test("Stripe unreachable during a staff payment: the bill unfreezes and the payment is recorded", async () => {
  const place = await fixture();
  await place.start();
  clearPublished();
  stripe.failNext("checkout.sessions.expire");

  const res = await place.pay(place.staff.waiter, { method: "CARD_TERMINAL" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal((await place.payments()).length, 1);
  await assertUnfrozen(place, "STAFF_PAYMENT");
});

test("Stripe unreachable when the guest goes back: 502 and the bill stays frozen", async () => {
  const place = await fixture();
  await place.start();
  clearPublished();
  stripe.failNext("checkout.sessions.expire");

  const res = await place.cancel();
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.code, "PAYMENT_PROVIDER_ERROR");
  assert.equal((await place.session()).status, "paying");
  assert.equal(eventsNamed("bill.unfrozen").length, 0);
});

test("Stripe unreachable when an owner unfreezes by hand: staff win, the bill opens", async () => {
  const place = await fixture();
  await place.start();
  clearPublished();
  stripe.failNext("checkout.sessions.expire");

  const res = await place.cancel(place.staff.owner);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await assertUnfrozen(place, "CANCELLED");
});

test("closing a frozen table expires the Checkout Session first, then closes", async () => {
  const place = await fixture();
  const checkoutSessionId = await place.start();
  clearPublished();

  const res = await place.close(place.staff.admin, { unpaidReason: "walked out" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertExpired(place, checkoutSessionId);
  const session = await place.session();
  assert.equal(session.status, "closed");
  assert.equal(session.paymentInProgress, undefined);
  const order = published.map((envelope) => envelope.message?.event).filter(Boolean);
  assert.deepEqual(order, ["bill.unfrozen", "session.closed"]);
  assert.equal(eventsNamed("bill.unfrozen")[0].message.data.reason, "STAFF_PAYMENT");
});

test("a waiter closing a frozen unpaid table gets 409 BILL_UNPAID and the guest's payment runs on", async () => {
  const place = await fixture();
  await place.start();
  const res = await place.close(place.staff.waiter);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "BILL_UNPAID");
  assert.equal(expireCalls().length, 0);
  assert.equal((await place.session()).status, "paying");
});
