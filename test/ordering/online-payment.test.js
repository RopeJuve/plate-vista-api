process.env.JWT_SECRET = "test-secret-online-payment";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateTableToken, generateToken, hashPassword } from "../../src/shared/auth.js";
import { cancelOrder, changeStatus, createOrder, updateOrder } from "../../src/modules/ordering/order.service.js";
import Payment from "../../src/modules/payments/payment.model.js";
import TableSession from "../../src/modules/ordering/session.model.js";
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
const THIRTY_MINUTES = 30 * 60 * 1000;

let replset;
let app;
let request;
let passwordHash;
let stripe;
let server;
let sockets;
let port;

const waitFor = async (messages, predicate, timeout = 2000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out; messages=${JSON.stringify(messages)}`);
};

const connect = (token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?v=2&token=${encodeURIComponent(token)}`);
    const messages = [];
    let closeCode = null;
    ws.on("message", (buf) => messages.push(JSON.parse(buf.toString())));
    ws.on("close", (code) => {
      closeCode = code;
    });
    ws.on("open", () => resolve({ ws, messages, closeCode: () => closeCode }));
    ws.on("error", reject);
  });

const ask = async (client, type, payload) => {
  const requestId = randomUUID();
  client.ws.send(JSON.stringify({ type, requestId, payload }));
  return waitFor(client.messages, (message) => message.type === "ack" && message.requestId === requestId);
};

const staffOf = (restaurant, position) =>
  Employee.create({
    restaurantId: restaurant._id,
    employee: `${position}-${randomUUID().slice(0, 8)}`,
    email: `${position}-${randomUUID().slice(0, 8)}@example.com`,
    password: passwordHash,
    position,
    role: position,
  });

// A restaurant where a guest may pay online, with one table and an open
// session. By default two orders: a pizza, then a pizza and a beer (24.50 €).
const fixture = async ({ chargesEnabled = true, orders = [{ pizza: 1 }, { pizza: 1, beer: 1 }] } = {}) => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({
    name: `R${suffix}`,
    slug: `r-${suffix}`,
    tse: { setupStep: "DONE", tssSerial: "serial", clientId: "client" },
    payoutAccount: { stripeAccountId: `acct_${suffix}`, chargesEnabled, detailsSubmitted: chargesEnabled },
  });
  const waiter = await staffOf(restaurant, "waiter");
  const kitchen = await staffOf(restaurant, "kitchen");
  const table = await Table.create({ restaurantId: restaurant._id, tableNumber: 1, capacity: 4 });
  const food = await Category.create({ restaurantId: restaurant._id, name: "food", station: "kitchen", position: 1 });
  const drinks = await Category.create({ restaurantId: restaurant._id, name: "drinks", station: "bar", position: 2 });
  const pizza = await MenuItem.create({
    restaurantId: restaurant._id,
    title: "Pizza",
    priceCents: 1000,
    categoryId: food._id,
    inStock: true,
  });
  const beer = await MenuItem.create({
    restaurantId: restaurant._id,
    title: "Beer",
    priceCents: 450,
    categoryId: drinks._id,
    inStock: true,
  });
  const ctx = {
    restaurantId: restaurant._id,
    requestId: randomUUID(),
    actor: { type: "employee", id: waiter._id, position: waiter.position },
  };
  const itemsOf = (counts) =>
    Object.entries(counts).map(([name, quantity]) => ({
      productId: String({ pizza, beer }[name]._id),
      quantity,
    }));
  const placed = [];
  for (const counts of orders) {
    const { order } = await createOrder(ctx, {
      clientOrderId: randomUUID(),
      tableId: String(table._id),
      items: itemsOf(counts),
    });
    placed.push(order);
  }
  const sessionId = placed[0].sessionId;
  const guestToken = generateTableToken({ restaurantId: restaurant._id, tableId: table._id, sessionId });
  const guestCtx = {
    restaurantId: restaurant._id,
    requestId: randomUUID(),
    actor: { type: "guest", id: null, sessionId, tableId: String(table._id) },
  };
  const start = (token = guestToken) =>
    request(app).post(`/api/v1/sessions/${sessionId}/online-payment`).set("Authorization", `Bearer ${token}`);
  const bill = () =>
    request(app).get(`/api/v1/sessions/${sessionId}/bill`).set("Authorization", `Bearer ${guestToken}`);
  return {
    restaurant,
    table,
    sessionId,
    orders: placed,
    ctx,
    guestCtx,
    kitchenCtx: { ...ctx, actor: { type: "employee", id: kitchen._id, position: kitchen.position } },
    itemsOf,
    guestToken,
    waiterToken: generateToken(waiter),
    start,
    bill,
  };
};

const checkoutCalls = () => stripe.calls.filter(([op]) => op === "checkout.sessions.create");

const rejectsWith = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.status, 409);
    return true;
  });
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
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  port = server.address().port;
  const { attachWebSocket } = await import("../../src/realtime/wsServer.js");
  sockets = attachWebSocket(server);
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
  for (const client of sockets?.clients || []) client.terminate();
  if (sockets) await new Promise((resolve) => sockets.close(() => resolve()));
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  await disconnectDatabase();
  await replset?.stop();
});

test("a guest starts an online payment: the bill freezes and Stripe gets the whole bill on the Payout Account", async () => {
  const place = await fixture();
  const before = Date.now();
  const res = await place.start();
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const calls = checkoutCalls();
  assert.equal(calls.length, 1);
  const [, params, options] = calls[0];
  assert.equal(options.stripeAccount, place.restaurant.payoutAccount.stripeAccountId);
  assert.equal(params.mode, "payment");
  assert.deepEqual(params.line_items, [
    { quantity: 2, price_data: { currency: "eur", unit_amount: 1000, product_data: { name: "Pizza" } } },
    { quantity: 1, price_data: { currency: "eur", unit_amount: 450, product_data: { name: "Beer" } } },
  ]);
  assert.deepEqual(params.metadata, {
    restaurantId: String(place.restaurant._id),
    sessionId: place.sessionId,
    amountCents: "2450",
  });
  assert.equal(params.payment_intent_data?.application_fee_amount, undefined);
  const page = `https://guest.example.com/r/${place.restaurant.slug}/t/${place.table.qrCode}`;
  assert.equal(params.success_url, `${page}?payment=return`);
  assert.equal(params.cancel_url, `${page}?payment=cancelled`);
  // Stripe's minimum is 30 minutes from when it creates the Checkout Session.
  const expiresAtMs = params.expires_at * 1000;
  assert.ok(expiresAtMs >= before + THIRTY_MINUTES, `${expiresAtMs} < ${before + THIRTY_MINUTES}`);
  assert.ok(expiresAtMs <= Date.now() + THIRTY_MINUTES + 60 * 1000);

  assert.match(res.body.url, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(new Date(res.body.expiresAt).getTime(), expiresAtMs);

  const bill = await place.bill();
  assert.equal(bill.body.session.status, "paying");
  assert.equal(bill.body.canPayOnline, false);

  // The frozen bill knows which kind of payment is in progress.
  const session = await TableSession.findOne({ _id: place.sessionId, restaurantId: place.restaurant._id }).lean();
  assert.equal(session.paymentInProgress.kind, "online");
  assert.equal(session.paymentInProgress.amountCents, 2450);
  assert.equal(session.paymentInProgress.url, res.body.url);
  assert.equal("onlinePayment" in session, false);
});

test("bill.frozen goes to staff and the session's room", async () => {
  const place = await fixture();
  clearPublished();
  const res = await place.start();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const frozen = published.filter((envelope) => envelope.message?.event === "bill.frozen");
  assert.equal(frozen.length, 1);
  assert.equal(String(frozen[0].restaurantId), String(place.restaurant._id));
  assert.equal(String(frozen[0].sessionId), place.sessionId);
  assert.equal(frozen[0].audience, undefined);
  assert.deepEqual(frozen[0].message.data, { sessionId: place.sessionId, expiresAt: res.body.expiresAt });
});

test("staff can start the online payment too", async () => {
  const place = await fixture();
  const res = await place.start(place.waiterToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test("platform fee: none at 0 bps, 150 bps of 20.00 € is 30 cents", async () => {
  const free = await fixture({ orders: [{ pizza: 2 }] });
  assert.equal((await free.start()).status, 200);
  assert.equal(checkoutCalls()[0][1].payment_intent_data?.application_fee_amount, undefined);

  process.env.STRIPE_APPLICATION_FEE_BPS = "150";
  const charged = await fixture({ orders: [{ pizza: 2 }] });
  assert.equal((await charged.start()).status, 200);
  assert.equal(checkoutCalls()[1][1].payment_intent_data.application_fee_amount, 30);
});

test("a second start while frozen gives the same url without a new Checkout Session", async () => {
  const place = await fixture();
  const first = await place.start();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  clearPublished();
  const second = await place.start(place.waiterToken);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(second.body, first.body);
  assert.equal(stripe.checkoutSessionsCreated(), 1);
  assert.equal(published.filter((envelope) => envelope.message?.event === "bill.frozen").length, 0);
});

test("a guest token for another session gets 404", async () => {
  const place = await fixture();
  const other = await fixture();
  const res = await request(app)
    .post(`/api/v1/sessions/${place.sessionId}/online-payment`)
    .set("Authorization", `Bearer ${other.guestToken}`);
  assert.equal(res.status, 404);
  assert.equal(stripe.checkoutSessionsCreated(), 0);
});

test("without Stripe keys starting answers 503 STRIPE_NOT_CONFIGURED", async () => {
  const place = await fixture();
  delete process.env.STRIPE_SECRET_KEY;
  setStripeClient(null);
  const res = await place.start();
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.code, "STRIPE_NOT_CONFIGURED");
  assert.equal((await place.bill()).body.session.status, "open");
});

test("canPayOnline false gives 409 ONLINE_PAYMENT_UNAVAILABLE and leaves the bill open", async () => {
  const place = await fixture({ chargesEnabled: false });
  const res = await place.start();
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "ONLINE_PAYMENT_UNAVAILABLE");
  assert.equal(stripe.checkoutSessionsCreated(), 0);
  assert.equal((await place.bill()).body.session.status, "open");
});

test("Stripe failing puts the bill back to open with 502 PAYMENT_PROVIDER_ERROR", async () => {
  const place = await fixture();
  stripe.failNext("checkout.sessions.create");
  const res = await place.start();
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.code, "PAYMENT_PROVIDER_ERROR");
  const bill = await place.bill();
  assert.equal(bill.body.session.status, "open");
  assert.equal(bill.body.canPayOnline, true);
  assert.equal(published.filter((envelope) => envelope.message?.event === "bill.frozen").length, 0);

  // The guest can try again.
  const again = await place.start();
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test("a frozen bill takes no new orders, from guests or staff", async () => {
  const place = await fixture();
  assert.equal((await place.start()).status, 200);
  const items = place.itemsOf({ beer: 1 });
  await rejectsWith(createOrder(place.guestCtx, { clientOrderId: randomUUID(), items }), "BILL_FROZEN");
  await rejectsWith(
    createOrder(place.ctx, { clientOrderId: randomUUID(), sessionId: place.sessionId, items }),
    "BILL_FROZEN"
  );
  await rejectsWith(
    createOrder(place.ctx, { clientOrderId: randomUUID(), tableId: String(place.table._id), items }),
    "BILL_FROZEN"
  );
  await rejectsWith(updateOrder(place.ctx, { orderId: place.orders[0]._id, items }), "BILL_FROZEN");
  assert.equal((await place.bill()).body.totalCents, 2450);
});

test("a frozen bill takes no cancellations", async () => {
  const place = await fixture();
  assert.equal((await place.start()).status, 200);
  const orderId = place.orders[1]._id;
  await rejectsWith(cancelOrder(place.guestCtx, { orderId }), "BILL_FROZEN");
  await rejectsWith(cancelOrder(place.ctx, { orderId, reason: "no", station: "bar" }), "BILL_FROZEN");
  await rejectsWith(changeStatus(place.ctx, { orderId, status: "cancelled" }), "BILL_FROZEN");
  assert.equal((await place.bill()).body.totalCents, 2450);
});

test("staff still move tickets forward on a frozen bill", async () => {
  const place = await fixture();
  assert.equal((await place.start()).status, 200);
  const orderId = place.orders[1]._id;
  for (const status of ["accepted", "preparing", "ready", "served"]) {
    const { order } = await changeStatus(place.kitchenCtx, { orderId, status, station: "kitchen" });
    assert.equal(order.tickets.find((ticket) => ticket.station === "kitchen").status, status);
  }
});

test("a guest coming back from Stripe to the table page rejoins the frozen bill", async () => {
  const place = await fixture();
  assert.equal((await place.start()).status, 200);
  const res = await request(app)
    .post(`/api/v1/auth/table/${place.table.qrCode}`)
    .send({ guestToken: place.guestToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(String(res.body.sessionId), place.sessionId);
  assert.equal(res.body.opened, false);
});

test("staff still see the frozen table on the board", async () => {
  const place = await fixture();
  assert.equal((await place.start()).status, 200);
  const res = await request(app).get("/api/v1/staff/board").set("Authorization", `Bearer ${place.waiterToken}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const session = res.body.sessions.find((entry) => entry._id === place.sessionId);
  assert.equal(session?.status, "paying");
  assert.equal(res.body.tables.find((table) => table._id === String(place.table._id)).status, "occupied");
  assert.equal(res.body.orders.filter((order) => order.sessionId === place.sessionId).length, 2);
});

test("a guest's socket stays connected while the bill is frozen, and orders sent on it get BILL_FROZEN", async () => {
  const place = await fixture();
  const guest = await connect(place.guestToken);
  assert.equal((await place.start()).status, 200);
  await waitFor(guest.messages, (message) => message.event === "bill.frozen");

  const late = await connect(place.guestToken);
  const ack = await ask(late, "order.create", { clientOrderId: randomUUID(), items: place.itemsOf({ beer: 1 }) });
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, "BILL_FROZEN");
  assert.equal(late.closeCode(), null);
  guest.ws.close();
  late.ws.close();
});
