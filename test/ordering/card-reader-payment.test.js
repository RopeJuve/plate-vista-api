process.env.JWT_SECRET = "test-secret-card-reader-payment";
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

const WEBHOOK_SECRET = "whsec_card_reader_payment_test";
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
    start: (body = { expectedTotalCents: 1450 }) => asWaiter("post", "/card-reader-payment", body),
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

test("starting freezes the bill at its total and the reader is told to collect exactly that amount", async () => {
  const p = await place();

  const before = Date.now();
  const res = await p.start();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), [...CARD_READER_PAYMENT_KEYS].sort());
  assert.match(res.body.id, /^[0-9a-f]{24}$/);
  assert.equal(res.body.sessionId, p.sessionId);
  assert.deepEqual(res.body.reader, { id: p.readerId, name: "Bar", simulated: true });
  assert.equal(res.body.amountCents, 1450);
  assert.equal(res.body.status, "IN_PROGRESS");
  assert.equal(res.body.failure, null);
  const startedAt = Date.parse(res.body.startedAt);
  const expiresAt = Date.parse(res.body.expiresAt);
  assert.ok(startedAt >= before - 1000 && startedAt <= Date.now());
  assert.ok(expiresAt > startedAt && expiresAt - startedAt <= 5 * 60 * 1000);

  const bill = await p.bill();
  assert.equal(bill.body.session.status, "paying");

  const [reader] = fake.readersOn(p.stripeAccountId);
  const [processCall] = callsOf("terminal.readers.processPaymentIntent");
  assert.equal(processCall[1], reader.id);
  assert.equal(processCall[3].stripeAccount, p.stripeAccountId);
  const intent = fake.paymentIntent(processCall[2].payment_intent);
  assert.equal(intent.amount, 1450);
  assert.equal(intent.currency, "eur");
});

test("the PaymentIntent is card-present on the Payout Account, with manual capture and the configured platform fee", async () => {
  const p = await place();
  const res = await p.start();
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const creates = callsOf("paymentIntents.create");
  assert.equal(creates.length, 1);
  const [, params, options] = creates[0];
  assert.equal(options.stripeAccount, p.stripeAccountId);
  assert.ok(options.idempotencyKey, "an idempotency key from the attempt");
  assert.equal(params.amount, 1450);
  assert.equal(params.currency, "eur");
  assert.deepEqual(params.payment_method_types, ["card_present"]);
  assert.equal(params.capture_method, "manual");
  // 150 bps of 14.50 € is 21.75 cents, rounded to 22.
  assert.equal(params.application_fee_amount, 22);
  assert.equal(params.metadata.restaurantId, String(p.restaurant._id));
  assert.equal(params.metadata.sessionId, p.sessionId);
});

test("starting twice for the same frozen bill gives one PaymentIntent and one reader request", async () => {
  const p = await place();
  const [first, second] = await Promise.all([p.start(), p.start()]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const third = await p.start();
  assert.equal(third.status, 200, JSON.stringify(third.body));

  assert.equal(second.body.id, first.body.id);
  assert.deepEqual(third.body, first.body);
  assert.equal(fake.paymentIntentsCreated(), 1);
  assert.equal(fake.readerRequests(), 1);
  assert.equal(eventsNamed("bill.frozen").length, 1);
});

test("the frozen event names the card reader kind, the reader and the total, and reaches the table and the staff board", async () => {
  const p = await place();
  const res = await p.start();
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const frozen = eventsNamed("bill.frozen");
  assert.equal(frozen.length, 1);
  assert.equal(String(frozen[0].restaurantId), String(p.restaurant._id));
  assert.equal(String(frozen[0].sessionId), p.sessionId);
  // No audience: it goes to the staff room as well as the session's room.
  assert.equal(frozen[0].audience, undefined);
  assert.deepEqual(frozen[0].message.data, {
    sessionId: p.sessionId,
    expiresAt: res.body.expiresAt,
    kind: "CARD_READER",
    readerName: "Bar",
    totalCents: 1450,
  });
});

// The webhook Stripe sends for a direct charge on the restaurant's account
// once the card is authorized on the reader.
const authorizedEvent = (p, paymentIntentId) => ({
  id: `evt_${randomUUID()}`,
  object: "event",
  type: "payment_intent.amount_capturable_updated",
  account: p.stripeAccountId,
  livemode: false,
  created: Math.floor(Date.now() / 1000),
  data: { object: fake.paymentIntent(paymentIntentId) },
});

const deliver = (event, secret = WEBHOOK_SECRET) => {
  const { body, signature } = fake.signedEvent(event, secret);
  return request(app)
    .post("/api/v1/webhooks/stripe")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", signature)
    .send(body);
};

const paymentIntentIdOf = () => callsOf("terminal.readers.processPaymentIntent")[0][2].payment_intent;

// Starts on the Simulated Reader and taps the approved test card.
const startAndTap = async (p) => {
  const started = await p.start();
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const tapped = await p.asWaiter("post", "/card-reader-payment/test-card", { card: "APPROVED" });
  assert.equal(tapped.status, 200, JSON.stringify(tapped.body));
  return { started, tapped, paymentIntentId: paymentIntentIdOf() };
};

test("presenting the approved test card on a Simulated Reader authorizes the PaymentIntent; the attempt is still in progress", async () => {
  const p = await place();
  const { started, tapped, paymentIntentId } = await startAndTap(p);

  assert.deepEqual(tapped.body, started.body);
  const [present] = callsOf("testHelpers.terminal.readers.presentPaymentMethod");
  assert.equal(present[1], fake.readersOn(p.stripeAccountId)[0].id);
  assert.equal(present[2].card_present.number, "4242424242424242");
  assert.equal(present[3].stripeAccount, p.stripeAccountId);
  assert.equal(fake.paymentIntent(paymentIntentId).status, "requires_capture");
  assert.equal((await p.bill()).body.session.status, "paying");
  assert.equal((await p.payments()).length, 0);
});

test("presenting a test card is refused in live mode, on a real reader, and without a card reader payment in progress", async () => {
  const idle = await place();
  const none = await idle.asWaiter("post", "/card-reader-payment/test-card", { card: "APPROVED" });
  assert.equal(none.status, 404, JSON.stringify(none.body));

  const real = await place({ reader: "real" });
  assert.equal((await real.start()).status, 200);
  const notSimulated = await real.asWaiter("post", "/card-reader-payment/test-card", { card: "APPROVED" });
  assert.equal(notSimulated.status, 409, JSON.stringify(notSimulated.body));
  assert.deepEqual(notSimulated.body, {
    code: "CARD_READER_NOT_SIMULATED",
    message: "Test cards work only on a simulated reader.",
  });

  const live = await place();
  assert.equal((await live.start()).status, 200);
  process.env.STRIPE_SECRET_KEY = "sk_live_card_reader_payment";
  const liveMode = await live.asWaiter("post", "/card-reader-payment/test-card", { card: "APPROVED" });
  assert.equal(liveMode.status, 409, JSON.stringify(liveMode.body));
  assert.deepEqual(liveMode.body, {
    code: "SIMULATED_READER_LIVE_MODE",
    message: "Simulated readers exist only in test mode.",
  });

  const invalid = await live.asWaiter("post", "/card-reader-payment/test-card", { card: "NOPE" });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal(callsOf("testHelpers.terminal.readers.presentPaymentMethod").length, 0);
});

test("the authorization webhook captures and records one CARD_READER Payment for the frozen amount, which gets TSE-signed", async () => {
  const p = await place();
  const { paymentIntentId } = await startAndTap(p);
  clearPublished();
  signed = [];

  const res = await deliver(authorizedEvent(p, paymentIntentId));
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.equal(fake.captures(), 1);
  const [capture] = callsOf("paymentIntents.capture");
  assert.equal(capture[1], paymentIntentId);
  assert.equal(capture[3].stripeAccount, p.stripeAccountId);
  assert.equal(fake.paymentIntent(paymentIntentId).status, "succeeded");

  const payments = await p.payments();
  assert.equal(payments.length, 1);
  const [payment] = payments;
  assert.equal(payment.method, "CARD_READER");
  assert.equal(payment.amountCents, 1450);
  assert.equal(payment.clientPaymentId, paymentIntentId);
  assert.equal(payment.paidBy, undefined);
  assert.equal(payment.tse.status, "PENDING");
  assert.deepEqual(signed.map(({ kind, id }) => ({ kind, id: String(id) })), [{ kind: "PAYMENT", id: String(payment._id) }]);

  const bill = await p.bill();
  assert.equal(bill.body.session.status, "open");
  assert.equal(bill.body.payment.method, "CARD_READER");
  assert.equal(bill.body.freeze, null);
  assert.equal(bill.body.cardReaderPayment, null);

  const paid = eventsNamed("bill.paid");
  assert.equal(paid.length, 1);
  assert.equal(paid[0].audience, undefined);
  assert.deepEqual(paid[0].message.data, {
    sessionId: p.sessionId,
    paymentId: String(payment._id),
    receiptToken: payment.receiptToken,
    method: "CARD_READER",
    totalCents: 1450,
  });
  assert.equal(eventsNamed("bill.unfrozen").length, 0);
});

test("the same authorization webhook delivered twice, or concurrently, records once and captures once", async () => {
  const p = await place();
  const { paymentIntentId } = await startAndTap(p);
  const event = authorizedEvent(p, paymentIntentId);

  const [a, b] = await Promise.all([deliver(event), deliver(event)]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const again = await deliver({ ...event, id: `evt_${randomUUID()}` });
  assert.equal(again.status, 200, JSON.stringify(again.body));

  assert.equal((await p.payments()).length, 1);
  assert.equal(fake.captures(), 1);
  assert.equal(eventsNamed("bill.paid").length, 1);
  assert.equal(signed.filter(({ kind }) => kind === "PAYMENT").length, 1);
});

test("an authorization event delivered out of order, after its Payment, records nothing more and captures nothing more", async () => {
  const p = await place();
  const { paymentIntentId } = await startAndTap(p);
  // The snapshot Stripe sent first, still requires_capture, arrives last.
  const stale = authorizedEvent(p, paymentIntentId);
  assert.equal((await deliver(authorizedEvent(p, paymentIntentId))).status, 200);

  const res = await deliver(stale);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await p.payments()).length, 1);
  assert.equal(fake.captures(), 1);
  assert.equal(eventsNamed("bill.paid").length, 1);
});

test("an authorization for a PaymentIntent the bill is not frozen for is not captured and records nothing", async () => {
  const p = await place();
  const { paymentIntentId } = await startAndTap(p);
  const event = authorizedEvent(p, paymentIntentId);
  event.data.object.id = "pi_other";

  const res = await deliver(event);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(fake.captures(), 0);
  assert.equal((await p.payments()).length, 0);
  assert.equal((await p.bill()).body.session.status, "paying");
});

test("online payment and card reader payment refuse each other on a frozen bill", async () => {
  const reading = await place();
  assert.equal((await reading.start()).status, 200);
  const online = await reading.asGuest("post", "/online-payment");
  assert.equal(online.status, 409, JSON.stringify(online.body));
  assert.equal(online.body.code, "ONLINE_PAYMENT_UNAVAILABLE");
  assert.equal(fake.checkoutSessionsCreated(), 0);
  // The guest going back from Stripe leaves the card reader payment alone.
  const cancel = await reading.asGuest("post", "/online-payment/cancel");
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.deepEqual(cancel.body, { status: "paying" });
  assert.equal((await reading.bill()).body.freeze.kind, "CARD_READER");

  fake = createFakeStripe();
  setStripeClient(fake);
  const paying = await place();
  assert.equal((await paying.asGuest("post", "/online-payment")).status, 200);
  const res = await paying.start();
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.deepEqual(res.body, {
    code: "PAYMENT_IN_PROGRESS",
    message: "A payment is already in progress for this bill.",
    details: { kind: "ONLINE", readerName: null },
  });
  assert.equal(fake.paymentIntentsCreated(), 0);
  assert.equal(fake.readerRequests(), 0);
});

test("a bill frozen for a card reader takes no new orders", async () => {
  const p = await place();
  assert.equal((await p.start()).status, 200);
  await assert.rejects(
    createOrder(p.ctx, { clientOrderId: randomUUID(), tableId: String(p.table._id), items: p.items }),
    (error) => error.code === "BILL_FROZEN"
  );
});

test("the record-payment endpoint still accepts only cash and Card Terminal", async () => {
  const p = await place();
  const res = await p.asWaiter("post", "/payments", {
    method: "CARD_READER",
    clientPaymentId: randomUUID(),
    expectedTotalCents: 1450,
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, "VALIDATION");
  assert.equal((await p.payments()).length, 0);
});

test("starting is refused while the Payout Account cannot take charges or the TSE is not active, and the bill stays open", async () => {
  const notReady = await place({ chargesEnabled: false });
  const payout = await notReady.start();
  assert.equal(payout.status, 409, JSON.stringify(payout.body));
  assert.deepEqual(payout.body, {
    code: "CARD_READER_PAYMENT_UNAVAILABLE",
    message: "Card reader payments are not available.",
    details: { reason: "PAYOUT_ACCOUNT_NOT_READY" },
  });

  const noTse = await place({ tse: false });
  const tse = await noTse.start();
  assert.equal(tse.status, 409, JSON.stringify(tse.body));
  assert.deepEqual(tse.body.details, { reason: "TSE_NOT_ACTIVE" });

  for (const p of [notReady, noTse]) assert.equal((await p.bill()).body.session.status, "open");
  assert.equal(fake.paymentIntentsCreated(), 0);
});

test("starting checks the total, the role, the reader and Stripe", async () => {
  const p = await place();
  const changed = await p.start({ expectedTotalCents: 1000 });
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.equal(changed.body.code, "BILL_CHANGED");
  assert.deepEqual(changed.body.details, { totalCents: 1450 });

  const invalid = await p.start({ expectedTotalCents: "a lot" });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.equal(invalid.body.code, "VALIDATION");

  const unknownReader = await p.start({ readerId: "6650c0ffee0000000000a001", expectedTotalCents: 1450 });
  assert.equal(unknownReader.status, 404, JSON.stringify(unknownReader.body));

  const guest = await p.asGuest("post", "/card-reader-payment", { expectedTotalCents: 1450 });
  assert.equal(guest.status, 403, JSON.stringify(guest.body));
  const bar = await p.asBar("post", "/card-reader-payment", { expectedTotalCents: 1450 });
  assert.equal(bar.status, 200, JSON.stringify(bar.body));

  const noReaders = await place({ reader: null });
  assert.equal((await noReaders.start()).status, 404);
  assert.equal((await noReaders.bill()).body.session.status, "open");
});

test("when Stripe fails to start, the bill stays open and nothing is frozen", async () => {
  const p = await place();
  fake.failNext("terminal.readers.processPaymentIntent");
  const res = await p.start();
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.code, "PAYMENT_PROVIDER_ERROR");
  const bill = await p.bill();
  assert.equal(bill.body.session.status, "open");
  assert.equal(bill.body.freeze, null);
  assert.equal(eventsNamed("bill.frozen").length, 0);
});

test("without Stripe keys starting and presenting test cards answer 503 STRIPE_NOT_CONFIGURED", async () => {
  const p = await place();
  setStripeClient(null);
  delete process.env.STRIPE_SECRET_KEY;
  for (const res of [
    await p.start(),
    await p.asWaiter("post", "/card-reader-payment/test-card", { card: "APPROVED" }),
  ]) {
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.code, "STRIPE_NOT_CONFIGURED");
  }
  const bill = await p.bill();
  assert.equal(bill.body.cardReader.state, "HIDDEN");
});

test("card reader payment is offered only when the Payout Account can take charges, the TSE is active and a reader exists", async () => {
  const ready = await place();
  const offered = (await ready.bill()).body;
  assert.equal(offered.cardReader.state, "OFFERED");
  assert.equal(offered.cardReader.reason, null);
  assert.deepEqual(offered.cardReader.readers.map((reader) => reader.name), ["Bar"]);
  assert.equal(offered.freeze, null);
  assert.equal(offered.cardReaderPayment, null);

  const noReader = (await (await place({ reader: null })).bill()).body;
  assert.deepEqual(noReader.cardReader, { state: "HIDDEN", reason: null, readers: [] });

  const notReady = (await (await place({ chargesEnabled: false })).bill()).body;
  assert.equal(notReady.cardReader.state, "DISABLED");
  assert.equal(notReady.cardReader.reason, "PAYOUT_ACCOUNT_NOT_READY");

  const noTse = (await (await place({ tse: false })).bill()).body;
  assert.equal(noTse.cardReader.state, "DISABLED");
  assert.equal(noTse.cardReader.reason, "TSE_NOT_ACTIVE");
});

test("while the bill is frozen, staff see the attempt and why it is frozen; guests see only the freeze", async () => {
  const p = await place();
  const started = await p.start();

  const staff = (await p.bill()).body;
  assert.deepEqual(staff.freeze, {
    kind: "CARD_READER",
    readerName: "Bar",
    totalCents: 1450,
    expiresAt: started.body.expiresAt,
  });
  assert.equal(staff.cardReader.state, "DISABLED");
  assert.equal(staff.cardReader.reason, "PAYMENT_IN_PROGRESS");
  assert.deepEqual(staff.cardReaderPayment, started.body);
  assert.equal(staff.canPayOnline, false);

  const guest = await p.guestBill();
  assert.equal(guest.status, 200, JSON.stringify(guest.body));
  assert.deepEqual(guest.body.freeze, staff.freeze);
  assert.equal("cardReader" in guest.body, false);
  assert.equal("cardReaderPayment" in guest.body, false);
});

test("a wrongly signed authorization webhook is refused and captures nothing", async () => {
  const p = await place();
  const { paymentIntentId } = await startAndTap(p);
  const res = await deliver(authorizedEvent(p, paymentIntentId), "whsec_wrong");
  assert.equal(res.status, 400);
  assert.equal(fake.captures(), 0);
  assert.equal((await p.payments()).length, 0);
});
