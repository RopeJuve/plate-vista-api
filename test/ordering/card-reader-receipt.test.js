process.env.JWT_SECRET = "test-secret-card-reader-receipt";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateToken, hashPassword } from "../../src/shared/auth.js";
import { createOrder } from "../../src/modules/ordering/order.service.js";
import Payment from "../../src/modules/payments/payment.model.js";
import { signing } from "../../src/modules/payments/signing.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";
import { setStripeClient } from "../../src/modules/payouts/stripe.js";
import { clearPublished } from "../../src/realtime/events.js";
import { createFakeStripe } from "../support/fakeStripe.js";

const WEBHOOK_SECRET = "whsec_card_reader_receipt_test";
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_card_reader_receipt",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  DASHBOARD_URL: "https://dashboard.example.com",
  GUEST_APP_URL: "https://guest.example.com",
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
    role: position,
  });

// A restaurant that takes card reader payments on a Simulated Reader named
// "Bar", with a menu of a 10.00 € pizza.
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
  const reader = await request(app)
    .post("/api/v1/restaurant/card-readers/simulated")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: "Bar" });
  assert.equal(reader.status, 201, JSON.stringify(reader.body));
  const food = await Category.create({ restaurantId: restaurant._id, name: "food", station: "kitchen", position: 1 });
  const pizza = await MenuItem.create({
    restaurantId: restaurant._id, title: "Pizza", priceCents: 1000, categoryId: food._id, inStock: true,
  });
  let tables = 0;

  // A new table with an open bill of `quantity` pizzas; returns its session id.
  const openBill = async (quantity = 1) => {
    tables += 1;
    const table = await Table.create({ restaurantId: restaurant._id, tableNumber: tables, capacity: 4 });
    const ctx = {
      restaurantId: restaurant._id,
      requestId: randomUUID(),
      actor: { type: "employee", id: waiter._id, position: waiter.position },
    };
    const { order } = await createOrder(ctx, {
      clientOrderId: randomUUID(),
      tableId: String(table._id),
      items: [{ productId: String(pizza._id), quantity }],
    });
    return order.sessionId;
  };

  const asWaiter = (method, path, body) => {
    const req = request(app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${waiterToken}`);
    return body === undefined ? req : req.send(body);
  };
  const asOwner = (method, path) => request(app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${ownerToken}`);
  return { restaurant, stripeAccountId, readerId: reader.body.id, openBill, asWaiter, asOwner };
};

const callsOf = (op) => fake.calls.filter(([name]) => name === op);

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

// Starts a card reader payment for the bill and taps the approved test card;
// returns the authorized PaymentIntent's id.
const tapCard = async (p, sessionId, totalCents) => {
  const started = await p.asWaiter("post", `/sessions/${sessionId}/card-reader-payment`, { readerId: p.readerId, expectedTotalCents: totalCents });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const tapped = await p.asWaiter("post", `/sessions/${sessionId}/card-reader-payment/test-card`, { card: "APPROVED" });
  assert.equal(tapped.status, 200, JSON.stringify(tapped.body));
  return callsOf("terminal.readers.processPaymentIntent").at(-1)[2].payment_intent;
};

// A bill paid on the card reader: tapped, and the authorization webhook delivered.
const payOnCardReader = async (p, sessionId, totalCents = 1000) => {
  const paymentIntentId = await tapCard(p, sessionId, totalCents);
  const res = await deliver(authorizedEvent(p, paymentIntentId));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return paymentIntentId;
};

const billOf = (p, sessionId) => p.asWaiter("get", `/sessions/${sessionId}/bill`);

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
  await disconnectDatabase();
  await replset?.stop();
});

test("a recorded card reader Payment carries exactly the card-present details, and nothing else from the card", async () => {
  const p = await place();
  const sessionId = await p.openBill();
  const before = Math.floor(Date.now() / 1000) * 1000;
  const paymentIntentId = await payOnCardReader(p, sessionId);

  const bill = await billOf(p, sessionId);
  assert.equal(bill.status, 200, JSON.stringify(bill.body));
  const { authorizedAt, ...details } = bill.body.payment.paymentDetails;
  assert.deepEqual(details, {
    type: "card_present",
    brand: "visa",
    last4: "4242",
    funding: "credit",
    authorizationCode: "123456",
    aid: "A0000000031010",
    applicationLabel: "VISA CREDIT",
    readMethod: "contactless_emv",
    transactionId: paymentIntentId,
  });
  const at = Date.parse(authorizedAt);
  assert.ok(at >= before && at <= Date.now(), authorizedAt);

  // Stored: exactly these, so no PAN, expiry, cardholder name, cryptogram or fingerprint.
  const [stored] = await Payment.find({ restaurantId: p.restaurant._id, sessionId }).lean();
  assert.deepEqual(Object.keys(stored.card).sort(), [
    "aid", "applicationLabel", "authorizationCode", "authorizedAt", "brand", "funding", "last4",
    "paymentIntentId", "readMethod", "type",
  ]);
});

test("the receipt of a card reader payment has the method and the card-present details, as the contract describes", async () => {
  const p = await place();
  const sessionId = await p.openBill(2);
  const paymentIntentId = await payOnCardReader(p, sessionId, 2000);
  const { body: bill } = await billOf(p, sessionId);

  const res = await request(app).get(`/api/v1/receipts/${bill.payment.receiptToken}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // The guest app labels CARD_READER "Card", the same as CARD_TERMINAL.
  assert.equal(res.body.method, "CARD_READER");
  assert.equal(res.body.totalCents, 2000);
  assert.deepEqual(res.body.paymentDetails, {
    type: "card_present",
    brand: "visa",
    last4: "4242",
    funding: "credit",
    authorizationCode: "123456",
    aid: "A0000000031010",
    applicationLabel: "VISA CREDIT",
    readMethod: "contactless_emv",
    transactionId: paymentIntentId,
    authorizedAt: bill.payment.paymentDetails.authorizedAt,
  });
});

test("sales stats count card reader and Card Terminal payments together as Card, naming each method within", async () => {
  const p = await place();
  const payByHand = async (method, quantity) => {
    const sessionId = await p.openBill(quantity);
    const res = await p.asWaiter("post", `/sessions/${sessionId}/payments`, {
      method, clientPaymentId: randomUUID(), expectedTotalCents: quantity * 1000,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  };
  await payByHand("CASH", 1);
  await payByHand("CARD_TERMINAL", 2);
  await payByHand("CARD_TERMINAL", 1);
  await payOnCardReader(p, await p.openBill(4), 4000);

  const res = await p.asOwner("get", "/statistics/sales/payment-methods");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, [
    { group: "CASH", count: 1, totalCents: 1000, methods: [{ method: "CASH", count: 1, totalCents: 1000 }] },
    {
      group: "CARD",
      count: 3,
      totalCents: 7000,
      methods: [
        { method: "CARD_TERMINAL", count: 2, totalCents: 3000 },
        { method: "CARD_READER", count: 1, totalCents: 4000 },
      ],
    },
    { group: "ONLINE", count: 0, totalCents: 0, methods: [] },
  ]);

  // Another restaurant's payments are not counted; a range outside them counts nothing.
  const other = await place();
  const empty = await other.asOwner("get", "/statistics/sales/payment-methods");
  assert.deepEqual(empty.body.map(({ count }) => count), [0, 0, 0]);
  const past = await p.asOwner("get", "/statistics/sales/payment-methods?start_date=2020-01-01&end_date=2020-01-31");
  assert.equal(past.status, 200, JSON.stringify(past.body));
  assert.deepEqual(past.body.map(({ count }) => count), [0, 0, 0]);
  const halfRange = await p.asOwner("get", "/statistics/sales/payment-methods?start_date=2020-01-01");
  assert.equal(halfRange.status, 400, JSON.stringify(halfRange.body));
});

test("when Stripe cannot give the card details the Payment is still recorded; a redelivered event fills them in", async () => {
  const p = await place();
  const sessionId = await p.openBill();
  const paymentIntentId = await tapCard(p, sessionId, 1000);
  const event = authorizedEvent(p, paymentIntentId);

  fake.failNext("paymentIntents.retrieve");
  const first = await deliver(event);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const paid = await billOf(p, sessionId);
  assert.equal(paid.body.payment.method, "CARD_READER");
  assert.equal(paid.body.payment.paymentDetails, null);
  const receipt = await request(app).get(`/api/v1/receipts/${paid.body.payment.receiptToken}`);
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.method, "CARD_READER");
  assert.equal("paymentDetails" in receipt.body, false);

  const again = await deliver(event);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const filled = await billOf(p, sessionId);
  assert.equal(filled.body.payment.id, paid.body.payment.id);
  assert.equal(filled.body.payment.paymentDetails.last4, "4242");
  assert.equal(filled.body.payment.paymentDetails.transactionId, paymentIntentId);
  assert.equal(fake.captures(), 1);
});
