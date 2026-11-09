process.env.JWT_SECRET = "test-secret-payments";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateToken, hashPassword } from "../../src/shared/auth.js";
import {
  cancelOrder,
  changeStatus,
  createOrder,
  executeOrderCommand,
  updateOrder,
} from "../../src/modules/ordering/order.service.js";
import { openOrJoinSessionSafe } from "../../src/modules/ordering/session.service.js";
import Order from "../../src/modules/ordering/order.model.js";
import TableSession from "../../src/modules/ordering/session.model.js";
import Payment from "../../src/modules/payments/payment.model.js";
import { stock } from "../../src/modules/ordering/stock.js";
import { signing } from "../../src/modules/payments/signing.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Category from "../../src/modules/categories/category.model.js";

let replset;
let app;
let request;
let passwordHash;

const staffOf = (restaurant, position) =>
  Employee.create({
    restaurantId: restaurant._id,
    employee: `${position}-${randomUUID().slice(0, 8)}`,
    email: `${position}-${randomUUID().slice(0, 8)}@example.com`,
    password: passwordHash,
    position,
    role: position,
  });

const fixture = async ({ tseActive = true } = {}) => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({
    name: `R${suffix}`,
    slug: `r-${suffix}`,
    ...(tseActive ? { tse: { setupStep: "DONE", tssSerial: "serial", clientId: "client" } } : {}),
  });
  const owner = await staffOf(restaurant, "owner");
  const admin = await staffOf(restaurant, "admin");
  const waiter = await staffOf(restaurant, "waiter");
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
    price: 10,
    priceCents: 1000,
    categoryId: category._id,
    inStock: true,
  });
  const ctx = (who = waiter) => ({
    restaurantId: restaurant._id,
    requestId: randomUUID(),
    actor: { type: "employee", id: who._id, position: who.position },
  });
  const as = (who = waiter) => (method, path) =>
    request(app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${generateToken(who)}`);
  const order = async (quantity = 1, sessionId) =>
    (
      await createOrder(ctx(), {
        clientOrderId: randomUUID(),
        ...(sessionId ? { sessionId } : { tableId: String(table._id) }),
        items: [{ productId: String(item._id), quantity }],
      })
    ).order;
  return { restaurant, owner, admin, waiter, table, item, ctx, as, order };
};

const pay = (place, sessionId, body = {}, who) =>
  place.as(who)("post", `/sessions/${sessionId}/payments`).send({
    method: "CASH",
    clientPaymentId: randomUUID(),
    ...body,
  });

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

test("cash and card each create a pending payment with a 32-hex receipt token", async () => {
  const requested = [];
  const original = signing.requestSigning;
  signing.requestSigning = async (paymentId) => {
    requested.push(String(paymentId));
  };
  try {
    for (const method of ["CASH", "CARD_TERMINAL"]) {
      const place = await fixture();
      const placed = await place.order(2);
      const res = await pay(place, placed.sessionId, { method, expectedTotalCents: 2000 });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body).sort(), [
        "amountCents",
        "id",
        "method",
        "paidAt",
        "receiptToken",
        "sessionId",
        "signature",
      ]);
      assert.equal(res.body.method, method);
      assert.equal(res.body.amountCents, 2000);
      assert.equal(res.body.sessionId, placed.sessionId);
      assert.match(res.body.receiptToken, /^[0-9a-f]{32}$/);
      assert.deepEqual(res.body.signature, { status: "PENDING" });
      assert.ok(!Number.isNaN(Date.parse(res.body.paidAt)));

      const stored = await Payment.findOne({ _id: res.body.id, restaurantId: place.restaurant._id });
      assert.equal(stored.tse.status, "PENDING");
      assert.equal(String(stored.paidBy), String(place.waiter._id));
      assert.equal(String(stored.tableId), String(place.table._id));
      assert.equal(requested.at(-1), res.body.id);

      const bill = await place.as()("get", `/sessions/${placed.sessionId}/bill`);
      assert.equal(bill.status, 200);
      assert.deepEqual(bill.body.payment, res.body);
    }
  } finally {
    signing.requestSigning = original;
  }
});

test("an unpaid bill reads payment null", async () => {
  const place = await fixture();
  const placed = await place.order(1);
  const bill = await place.as()("get", `/sessions/${placed.sessionId}/bill`);
  assert.equal(bill.body.payment, null);
});

test("replaying the same clientPaymentId answers 200 with the same payment and writes nothing", async () => {
  const place = await fixture();
  const placed = await place.order(1);
  const clientPaymentId = randomUUID();
  const first = await pay(place, placed.sessionId, { clientPaymentId, expectedTotalCents: 1000 });
  assert.equal(first.status, 201);
  const again = await pay(place, placed.sessionId, {
    clientPaymentId,
    method: "CARD_TERMINAL",
    expectedTotalCents: 1000,
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
  assert.equal(await Payment.countDocuments({ restaurantId: place.restaurant._id }), 1);

  const other = await pay(place, placed.sessionId, { expectedTotalCents: 1000 });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, "BILL_PAID");
});

test("two different concurrent payments: exactly one 201, the other BILL_PAID", async () => {
  const place = await fixture();
  const placed = await place.order(3);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => pay(place, placed.sessionId, { expectedTotalCents: 3000 }))
  );
  const statuses = results.map((res) => res.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409], JSON.stringify(results.map((res) => res.body)));
  assert.ok(results.filter((res) => res.status === 409).every((res) => res.body.code === "BILL_PAID"));
  assert.equal(await Payment.countDocuments({ restaurantId: place.restaurant._id }), 1);
});

test("concurrent requests with the same clientPaymentId get one 201 and replays", async () => {
  const place = await fixture();
  const placed = await place.order(1);
  const clientPaymentId = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      pay(place, placed.sessionId, { clientPaymentId, expectedTotalCents: 1000 })
    )
  );
  assert.deepEqual(results.map((res) => res.status).sort(), [200, 200, 201]);
  assert.equal(new Set(results.map((res) => res.body.id)).size, 1);
});

test("a stale expected total is BILL_CHANGED with the current total", async () => {
  const place = await fixture();
  const placed = await place.order(1);
  await place.order(2, placed.sessionId);
  const res = await pay(place, placed.sessionId, { expectedTotalCents: 1000 });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "BILL_CHANGED");
  assert.equal(res.body.details.totalCents, 3000);
  assert.equal(await Payment.countDocuments({ restaurantId: place.restaurant._id }), 0);
});

test("TSE not active is 412, an empty bill 422, another restaurant's session 404, bad input 400", async () => {
  const inactive = await fixture({ tseActive: false });
  const placed = await inactive.order(1);
  const noTse = await pay(inactive, placed.sessionId, { expectedTotalCents: 1000 });
  assert.equal(noTse.status, 412);
  assert.equal(noTse.body.code, "TSE_NOT_ACTIVE");

  const place = await fixture();
  const empty = await openOrJoinSessionSafe(place.restaurant._id, place.table._id);
  const emptyRes = await pay(place, empty._id, { expectedTotalCents: 0 });
  assert.equal(emptyRes.status, 422);
  assert.equal(emptyRes.body.code, "BILL_EMPTY");

  const cancelled = await place.order(1, String(empty._id));
  await cancelOrder(place.ctx(), { orderId: cancelled._id, reason: "no" });
  const stillEmpty = await pay(place, empty._id, { expectedTotalCents: 0 });
  assert.equal(stillEmpty.body.code, "BILL_EMPTY");

  const other = await fixture();
  const theirs = await other.order(1);
  const foreign = await pay(place, theirs.sessionId, { expectedTotalCents: 1000 });
  assert.equal(foreign.status, 404);
  assert.equal(await Payment.countDocuments({ restaurantId: other.restaurant._id }), 0);

  const missing = await pay(place, "0123456789abcdef01234567", { expectedTotalCents: 1000 });
  assert.equal(missing.status, 404);

  const ours = await place.order(1);
  for (const body of [
    { method: "ONLINE", expectedTotalCents: 1000 },
    { method: "BITCOIN", expectedTotalCents: 1000 },
    { clientPaymentId: "", expectedTotalCents: 1000 },
    { expectedTotalCents: 10.5 },
    {},
  ]) {
    const res = await pay(place, ours.sessionId, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, "VALIDATION");
  }

  const guest = await request(app)
    .post(`/api/v1/sessions/${ours.sessionId}/payments`)
    .send({ method: "CASH", clientPaymentId: randomUUID(), expectedTotalCents: 1000 });
  assert.equal(guest.status, 401);
});

test("a paid bill takes no new order, edit or cancel", async () => {
  const place = await fixture();
  const placed = await place.order(1);
  const res = await pay(place, placed.sessionId, { expectedTotalCents: 1000 });
  assert.equal(res.status, 201);
  const isPaid = (error) => error.code === "BILL_PAID" && error.status === 409;

  await assert.rejects(() => place.order(1, placed.sessionId), isPaid);
  await assert.rejects(
    () => createOrder(place.ctx(), {
      clientOrderId: randomUUID(),
      tableId: String(place.table._id),
      items: [{ productId: String(place.item._id), quantity: 1 }],
    }),
    isPaid
  );
  await assert.rejects(
    () => updateOrder(place.ctx(), { orderId: placed._id, items: [{ productId: String(place.item._id), quantity: 5 }] }),
    isPaid
  );
  await assert.rejects(() => cancelOrder(place.ctx(), { orderId: placed._id, reason: "x" }), isPaid);
  await assert.rejects(
    () => cancelOrder(place.ctx(), { orderId: placed._id, reason: "x", station: "kitchen" }),
    isPaid
  );
  await assert.rejects(
    () => changeStatus(place.ctx(), { orderId: placed._id, status: "cancelled" }),
    isPaid
  );
  await assert.rejects(
    () => executeOrderCommand(place.ctx(), { type: "order.cancel", payload: { orderId: placed._id } }),
    isPaid
  );
  const guestCtx = {
    restaurantId: place.restaurant._id,
    actor: { type: "guest", id: null, sessionId: placed.sessionId, tableId: String(place.table._id) },
  };
  await assert.rejects(
    () => createOrder(guestCtx, { clientOrderId: randomUUID(), items: [{ productId: String(place.item._id), quantity: 1 }] }),
    isPaid
  );

  const stored = await Order.find({ restaurantId: place.restaurant._id }).lean();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "pending");
  assert.equal(stored[0].totalCents, 1000);

  // Kitchen still works the paid order.
  const accepted = await changeStatus(place.ctx(), { orderId: placed._id, status: "accepted" });
  assert.equal(accepted.order.status, "accepted");
});

test("closing: unpaid is 409, owner/admin override stores the reason, other roles 403, 0 € closes", async () => {
  const place = await fixture();
  const placed = await place.order(1);
  const close = (who, body = {}) => place.as(who)("post", `/sessions/${placed.sessionId}/close`).send(body);

  const unpaid = await close(place.waiter);
  assert.equal(unpaid.status, 409);
  assert.equal(unpaid.body.code, "BILL_UNPAID");
  const waiterOverride = await close(place.waiter, { unpaidReason: "Guest ran off" });
  assert.equal(waiterOverride.status, 403);
  assert.equal((await TableSession.findOne({ _id: placed.sessionId, restaurantId: place.restaurant._id })).status, "open");

  const tooLong = await close(place.admin, { unpaidReason: "x".repeat(501) });
  assert.equal(tooLong.status, 400);

  const override = await close(place.admin, { unpaidReason: "Guest ran off" });
  assert.equal(override.status, 200, JSON.stringify(override.body));
  assert.equal(override.body.status, "closed");
  const stored = await TableSession.findOne({ _id: placed.sessionId, restaurantId: place.restaurant._id });
  assert.equal(stored.unpaidCloseReason, "Guest ran off");
  assert.equal(String(stored.unpaidClosedBy), String(place.admin._id));

  const ownerPlace = await fixture();
  const ownerOrder = await ownerPlace.order(1);
  const byOwner = await ownerPlace.as(ownerPlace.owner)("post", `/sessions/${ownerOrder.sessionId}/close`)
    .send({ unpaidReason: "Invited" });
  assert.equal(byOwner.status, 200);

  const free = await fixture();
  const empty = await openOrJoinSessionSafe(free.restaurant._id, free.table._id);
  const zero = await free.as(free.waiter)("post", `/sessions/${empty._id}/close`).send({});
  assert.equal(zero.status, 200);
  const closedEmpty = await TableSession.findOne({ _id: empty._id, restaurantId: free.restaurant._id });
  assert.equal(closedEmpty.status, "closed");
  assert.equal(closedEmpty.unpaidCloseReason, undefined);
  const table = await Table.findOne({ _id: free.table._id, restaurantId: free.restaurant._id });
  assert.equal(table.status, "vacant");
});

test("a paid bill closes without a reason", async () => {
  const place = await fixture();
  const placed = await place.order(2);
  assert.equal((await pay(place, placed.sessionId, { expectedTotalCents: 2000 })).status, 201);
  const closed = await place.as()("post", `/sessions/${placed.sessionId}/close`).send({});
  assert.equal(closed.status, 200);
  const stored = await TableSession.findOne({ _id: placed.sessionId, restaurantId: place.restaurant._id });
  assert.equal(stored.status, "closed");
  assert.equal(stored.unpaidCloseReason, undefined);
});

test("an order racing a payment is rejected with BILL_PAID instead of landing on the paid bill", async () => {
  const place = await fixture();
  const placed = await place.order(1);
  let paid;
  // Staff record the payment after the order is written but before it commits.
  stock.afterSave = async () => {
    if (paid) return;
    paid = await pay(place, placed.sessionId, { expectedTotalCents: 1000 });
  };
  try {
    await assert.rejects(() => place.order(2, placed.sessionId), (error) => error.code === "BILL_PAID");
  } finally {
    stock.afterSave = null;
  }
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal(paid.body.amountCents, 1000);
  assert.equal(await Order.countDocuments({ restaurantId: place.restaurant._id }), 1);
});
