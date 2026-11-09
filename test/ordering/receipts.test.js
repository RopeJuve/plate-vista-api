process.env.JWT_SECRET = "test-secret-receipts";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateToken, hashPassword } from "../../src/shared/auth.js";
import { cancelOrder, createOrder } from "../../src/modules/ordering/order.service.js";
import Payment from "../../src/modules/payments/payment.model.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";
import receiptRouter from "../../src/modules/payments/receipt.routes.js";
import { receiptLimiter } from "../../src/shared/rateLimiters.js";

let replset;
let app;
let request;
let passwordHash;

const LEGAL = {
  legalName: "Pizzeria Beispiel GmbH",
  address: { street: "Hauptstr. 1", zip: "10115", city: "Berlin", country: "DE" },
  taxNumber: "21/815/08150",
};

const fixture = async () => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({
    name: `Pizzeria ${suffix}`,
    slug: `r-${suffix}`,
    legal: LEGAL,
    tse: {
      setupStep: "DONE",
      tssId: "tss-internal",
      clientId: "client-internal",
      tssSerial: "tss-serial",
      clientSerial: "client-serial",
      adminPinEnc: "pin-secret-enc",
      adminPukEnc: "puk-secret-enc",
    },
  });
  const waiter = await Employee.create({
    restaurantId: restaurant._id,
    employee: `waiter-${suffix}`,
    email: `waiter-${suffix}@example.com`,
    password: passwordHash,
    position: "waiter",
    role: "waiter",
  });
  const table = await Table.create({ restaurantId: restaurant._id, tableNumber: 7, capacity: 4 });
  const food = await Category.create({
    restaurantId: restaurant._id,
    name: "Food",
    station: "kitchen",
    vatRate: "REDUCED_1",
    position: 1,
  });
  const drinks = await Category.create({
    restaurantId: restaurant._id,
    name: "Drinks",
    station: "bar",
    vatRate: "NORMAL",
    position: 2,
  });
  const menuItem = (title, priceCents, category) =>
    MenuItem.create({
      restaurantId: restaurant._id,
      title,
      price: priceCents / 100,
      priceCents,
      categoryId: category._id,
      inStock: true,
    });
  const pizza = await menuItem("Pizza", 1000, food);
  const salad = await menuItem("Salad", 850, food);
  const beer = await menuItem("Beer", 450, drinks);
  const ctx = {
    restaurantId: restaurant._id,
    requestId: randomUUID(),
    actor: { type: "employee", id: waiter._id, position: waiter.position },
  };
  const order = async (lines, sessionId) =>
    (
      await createOrder(ctx, {
        clientOrderId: randomUUID(),
        ...(sessionId ? { sessionId } : { tableId: String(table._id) }),
        items: lines.map(([item, quantity]) => ({ productId: String(item._id), quantity })),
      })
    ).order;
  const pay = async (sessionId, expectedTotalCents, method = "CASH") => {
    const res = await request(app)
      .post(`/api/v1/sessions/${sessionId}/payments`)
      .set("Authorization", `Bearer ${generateToken(waiter)}`)
      .send({ method, clientPaymentId: randomUUID(), expectedTotalCents });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  return { restaurant, waiter, table, pizza, salad, beer, ctx, order, pay };
};

// Pizza + 2 beer; then 2 pizza + salad; then beer + pizza with the kitchen
// ticket cancelled. Total: 3 pizza 3000 + 3 beer 1350 + salad 850 = 5200.
const mixedBill = async (place) => {
  const first = await place.order([
    [place.pizza, 1],
    [place.beer, 2],
  ]);
  await place.order(
    [
      [place.pizza, 2],
      [place.salad, 1],
    ],
    first.sessionId
  );
  const third = await place.order(
    [
      [place.beer, 1],
      [place.pizza, 1],
    ],
    first.sessionId
  );
  await cancelOrder(place.ctx, { orderId: third._id, reason: "kitchen closed", station: "kitchen" });
  const payment = await place.pay(first.sessionId, 5200);
  return { sessionId: first.sessionId, payment };
};

const getReceipt = (token) => request(app).get(`/api/v1/receipts/${token}`);

const signPayment = (restaurantId, paymentId) =>
  Payment.updateOne(
    { _id: paymentId, restaurantId },
    {
      $set: {
        "tse.status": "SIGNED",
        "tse.txId": "tx-internal-id",
        "tse.revision": 2,
        "tse.txNumber": 42,
        "tse.timeStart": new Date("2026-11-09T12:00:00.000Z"),
        "tse.timeEnd": new Date("2026-11-09T12:00:01.000Z"),
        "tse.signatureValue": "c2lnbmF0dXJl",
        "tse.signatureCounter": 1234,
        "tse.tssSerial": "tss-serial",
        "tse.clientSerial": "client-serial",
        "tse.qrCodeData": "V0;client-serial;Kassenbeleg-V1;...",
        "tse.lastError": "old error",
        "tse.retryCount": 1,
      },
    }
  );

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

test("a valid token answers the receipt; lines merge across orders and leave out cancelled tickets", async () => {
  const place = await fixture();
  const { payment } = await mixedBill(place);
  const res = await getReceipt(payment.receiptToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), [
    "lines",
    "method",
    "paidAt",
    "restaurant",
    "signature",
    "totalCents",
    "totalsByVat",
  ]);
  assert.deepEqual(res.body.restaurant, {
    name: place.restaurant.name,
    legalName: LEGAL.legalName,
    address: LEGAL.address,
    taxNumber: LEGAL.taxNumber,
  });
  assert.deepEqual(res.body.lines, [
    { title: "Pizza", quantity: 3, unitPriceCents: 1000, lineTotalCents: 3000, vatRate: "REDUCED_1" },
    { title: "Beer", quantity: 3, unitPriceCents: 450, lineTotalCents: 1350, vatRate: "NORMAL" },
    { title: "Salad", quantity: 1, unitPriceCents: 850, lineTotalCents: 850, vatRate: "REDUCED_1" },
  ]);
  assert.equal(res.body.totalCents, 5200);
  assert.equal(res.body.method, "CASH");
  assert.equal(res.body.paidAt, payment.paidAt);
  assert.deepEqual(res.body.signature, { status: "PENDING" });
});

test("mixed 19 %/7 % bill: gross per rate sums to the total, net + VAT = gross", async () => {
  const place = await fixture();
  const { payment } = await mixedBill(place);
  const res = await getReceipt(payment.receiptToken);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.totalsByVat, [
    { vatRate: "NORMAL", netCents: 1134, vatCents: 216, grossCents: 1350 },
    { vatRate: "REDUCED_1", netCents: 3598, vatCents: 252, grossCents: 3850 },
  ]);
  const gross = res.body.totalsByVat.reduce((sum, row) => sum + row.grossCents, 0);
  assert.equal(gross, res.body.totalCents);
  for (const row of res.body.totalsByVat) assert.equal(row.netCents + row.vatCents, row.grossCents);
});

test("an unknown or malformed token is 404; no auth or tenant header is needed", async () => {
  for (const token of ["0".repeat(32), "not-a-token", "507f1f77bcf86cd799439011"]) {
    const res = await getReceipt(token);
    assert.equal(res.status, 404, token);
  }
});

test("a payment's id does not open its receipt", async () => {
  const place = await fixture();
  const { payment } = await mixedBill(place);
  const res = await getReceipt(payment.id);
  assert.equal(res.status, 404);
});

test("a SIGNED receipt carries the signature fields; FAILED carries only the status", async () => {
  const place = await fixture();
  const { payment } = await mixedBill(place);
  await signPayment(place.restaurant._id, payment.id);
  const signed = await getReceipt(payment.receiptToken);
  assert.equal(signed.status, 200);
  assert.deepEqual(signed.body.signature, {
    status: "SIGNED",
    txNumber: 42,
    timeStart: "2026-11-09T12:00:00.000Z",
    timeEnd: "2026-11-09T12:00:01.000Z",
    value: "c2lnbmF0dXJl",
    counter: 1234,
    tssSerial: "tss-serial",
    clientSerial: "client-serial",
    qrCodeData: "V0;client-serial;Kassenbeleg-V1;...",
  });

  await Payment.updateOne(
    { _id: payment.id, restaurantId: place.restaurant._id },
    { $set: { "tse.status": "FAILED", "tse.lastError": "fiskaly down" } }
  );
  const failed = await getReceipt(payment.receiptToken);
  assert.deepEqual(failed.body.signature, { status: "FAILED" });
});

const FORBIDDEN_KEYS = new Set([
  "_id",
  "id",
  "restaurantId",
  "sessionId",
  "tableId",
  "productId",
  "paymentId",
  "paidBy",
  "employee",
  "employeeId",
  "clientPaymentId",
  "clientOrderId",
  "receiptToken",
  "lastError",
  "retryCount",
  "nextAttemptAt",
  "txId",
  "revision",
  "tssId",
  "clientId",
  "adminPinEnc",
  "adminPukEnc",
  "pin",
  "puk",
  "tse",
  "slug",
  "notes",
  "station",
]);

const leaks = (value, forbiddenValues, path = "$") => {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...leaks(item, forbiddenValues, `${path}[${index}]`)));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) found.push(`${path}.${key}`);
      found.push(...leaks(child, forbiddenValues, `${path}.${key}`));
    }
  } else if (typeof value === "string" && forbiddenValues.some((bad) => value.includes(bad))) {
    found.push(`${path} = ${value}`);
  }
  return found;
};

test("no internal ids, employee data, errors, PIN/PUK or clientPaymentId leak", async () => {
  const place = await fixture();
  const { payment, sessionId } = await mixedBill(place);
  await signPayment(place.restaurant._id, payment.id);
  const stored = await Payment.findOne({ _id: payment.id, restaurantId: place.restaurant._id }).lean();
  const forbiddenValues = [
    String(place.restaurant._id),
    String(place.waiter._id),
    place.waiter.employee,
    place.waiter.email,
    String(place.table._id),
    String(place.pizza._id),
    sessionId,
    payment.id,
    stored.clientPaymentId,
    payment.receiptToken,
    "old error",
    "tx-internal-id",
    "tss-internal",
    "client-internal",
    "pin-secret-enc",
    "puk-secret-enc",
    place.restaurant.slug,
  ];
  for (const res of [await getReceipt(payment.receiptToken)]) {
    assert.equal(res.status, 200);
    assert.deepEqual(leaks(res.body, forbiddenValues), []);
  }

  // The checker itself catches a leak.
  assert.deepEqual(leaks({ a: [{ lastError: "x" }] }, []), ["$.a[0].lastError"]);
  assert.deepEqual(leaks({ a: `pay ${payment.id}` }, [payment.id]), [`$.a = pay ${payment.id}`]);
});

test("the receipt route is rate limited: 60 requests a minute per IP", async () => {
  const route = receiptRouter.stack.find((layer) => layer.route?.path === "/:receiptToken");
  assert.ok(route, "receipt route exists");
  assert.ok(
    route.route.stack.some((layer) => layer.handle === receiptLimiter),
    "receiptLimiter is on the route"
  );

  const first = await getReceipt("f".repeat(32));
  assert.equal(first.status, 404);
  assert.equal(first.headers["ratelimit-policy"], "60;w=60");
  const statuses = [];
  for (let i = 0; i < 61; i += 1) statuses.push((await getReceipt("f".repeat(32))).status);
  const limitedAt = statuses.indexOf(429);
  assert.ok(limitedAt >= 0, "the 61st request in a minute is limited");
  assert.ok(statuses.slice(limitedAt).every((status) => status === 429));
  const limited = await getReceipt("f".repeat(32));
  assert.equal(limited.body.code, "RATE_LIMITED");
});
