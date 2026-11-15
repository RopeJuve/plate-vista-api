process.env.JWT_SECRET = "test-secret-receipt-token";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";
process.env.TRUST_PROXY = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateTableToken, generateToken, hashPassword } from "../../src/shared/auth.js";
import { createOrder } from "../../src/modules/ordering/order.service.js";
import { closeSession } from "../../src/modules/ordering/session.service.js";
import TableSession from "../../src/modules/ordering/session.model.js";
import Payment from "../../src/modules/payments/payment.model.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";
import sessionRouter from "../../src/modules/ordering/session.routes.js";
import { receiptTokenLimiter } from "../../src/shared/rateLimiters.js";

let replset;
let app;
let request;
let passwordHash;

const fixture = async () => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({
    name: `R${suffix}`,
    slug: `r-${suffix}`,
    tse: { setupStep: "DONE", tssSerial: "serial", clientId: "client" },
  });
  const waiter = await Employee.create({
    restaurantId: restaurant._id,
    employee: `waiter-${suffix}`,
    email: `waiter-${suffix}@example.com`,
    password: passwordHash,
    position: "waiter",
    role: "waiter",
  });
  const table = await Table.create({ restaurantId: restaurant._id, tableNumber: 1, capacity: 4 });
  const category = await Category.create({
    restaurantId: restaurant._id,
    name: "food",
    station: "kitchen",
    position: 1,
  });
  const item = await MenuItem.create({
    restaurantId: restaurant._id,
    title: "Pizza",
    priceCents: 1000,
    categoryId: category._id,
    inStock: true,
  });
  const ctx = {
    restaurantId: restaurant._id,
    requestId: randomUUID(),
    actor: { type: "employee", id: waiter._id, position: waiter.position },
  };
  const staffToken = generateToken(waiter);
  const order = async () => {
    const { order: placed } = await createOrder(ctx, {
      clientOrderId: randomUUID(),
      tableId: String(table._id),
      items: [{ productId: String(item._id), quantity: 1 }],
    });
    return placed.sessionId;
  };
  const guestToken = (sessionId) =>
    generateTableToken({ restaurantId: restaurant._id, tableId: table._id, sessionId });
  const pay = async (sessionId, method = "CASH") => {
    const res = await request(app)
      .post(`/api/v1/sessions/${sessionId}/payments`)
      .set("Authorization", `Bearer ${staffToken}`)
      .send({ method, clientPaymentId: randomUUID(), expectedTotalCents: 1000 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  return { restaurant, ctx, staffToken, order, guestToken, pay };
};

const getReceiptToken = (sessionId, token, ip = "198.51.100.1") =>
  request(app)
    .get(`/api/v1/sessions/${sessionId}/receipt-token`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Forwarded-For", ip);

test.before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_DB_URL = replset.getUri();
  await connectToDatabase();
  ({ default: request } = await import("supertest"));
  ({ default: app } = await import("../../src/app.js"));
  passwordHash = await hashPassword("supersecret1");
  await Payment.init();
}, { timeout: 180000 });

test.after(async () => {
  await disconnectDatabase();
  await replset?.stop();
});

test("a paid bill answers its receipt token, to the guest and to staff", async () => {
  for (const method of ["CASH", "CARD_TERMINAL"]) {
    const place = await fixture();
    const sessionId = await place.order();
    const payment = await place.pay(sessionId, method);

    const guest = await getReceiptToken(sessionId, place.guestToken(sessionId));
    assert.equal(guest.status, 200, JSON.stringify(guest.body));
    assert.deepEqual(guest.body, { receiptToken: payment.receiptToken });

    const staff = await getReceiptToken(sessionId, place.staffToken);
    assert.equal(staff.status, 200);
    assert.deepEqual(staff.body, { receiptToken: payment.receiptToken });
  }
});

test("a session that is paying online answers 202 PAYING", async () => {
  const place = await fixture();
  const sessionId = await place.order();
  await TableSession.updateOne(
    { _id: sessionId, restaurantId: place.restaurant._id },
    { $set: { status: "paying" } }
  );
  const res = await getReceiptToken(sessionId, place.guestToken(sessionId));
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { status: "PAYING" });
});

test("no payment and not paying is 404", async () => {
  const place = await fixture();
  const sessionId = await place.order();
  const res = await getReceiptToken(sessionId, place.guestToken(sessionId));
  assert.equal(res.status, 404);
  assert.equal(res.body.receiptToken, undefined);
});

test("a guest of another session is 404, even when that bill is paid", async () => {
  const place = await fixture();
  const paidSession = await place.order();
  await place.pay(paidSession);
  await closeSession(place.ctx, paidSession);
  const otherSession = await place.order();
  assert.notEqual(String(otherSession), String(paidSession));

  const res = await getReceiptToken(paidSession, place.guestToken(otherSession));
  assert.equal(res.status, 404);
  assert.equal(res.body.receiptToken, undefined);
});

test("staff of another restaurant get 404", async () => {
  const place = await fixture();
  const other = await fixture();
  const sessionId = await place.order();
  await place.pay(sessionId);
  const res = await getReceiptToken(sessionId, other.staffToken);
  assert.equal(res.status, 404);
});

test("after staff close the table, the guest token of that session still gets 200", async () => {
  const place = await fixture();
  const sessionId = await place.order();
  const token = place.guestToken(sessionId);
  const payment = await place.pay(sessionId);
  await closeSession(place.ctx, sessionId);
  const stored = await TableSession.findOne({ _id: sessionId, restaurantId: place.restaurant._id });
  assert.equal(stored.status, "closed");

  const res = await getReceiptToken(sessionId, token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { receiptToken: payment.receiptToken });
});

test("the receipt-token route is rate limited: 60 requests a minute per IP", async () => {
  const route = sessionRouter.stack.find((layer) => layer.route?.path === "/:id/receipt-token");
  assert.ok(route, "receipt-token route exists");
  assert.ok(
    route.route.stack.some((layer) => layer.handle === receiptTokenLimiter),
    "receiptTokenLimiter is on the route"
  );

  const place = await fixture();
  const sessionId = await place.order();
  const token = place.guestToken(sessionId);
  const ip = "198.51.100.99";
  const first = await getReceiptToken(sessionId, token, ip);
  assert.equal(first.headers["ratelimit-policy"], "60;w=60");
  const statuses = [first.status];
  for (let i = 0; i < 60; i += 1) statuses.push((await getReceiptToken(sessionId, token, ip)).status);
  assert.ok(statuses.slice(0, 60).every((status) => status === 404));
  assert.equal(statuses[60], 429);
  const limited = await getReceiptToken(sessionId, token, ip);
  assert.equal(limited.body.code, "RATE_LIMITED");

  const otherIp = await getReceiptToken(sessionId, token, "198.51.100.100");
  assert.equal(otherIp.status, 404);
});
