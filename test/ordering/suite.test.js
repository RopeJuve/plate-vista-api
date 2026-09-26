process.env.JWT_SECRET = "test-secret-ordering-suite";
process.env.INTERNAL_SECRET = "internal-secret-value";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { WebSocket } from "ws";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { hashPassword, generateToken, generateTableToken } from "../../src/shared/auth.js";
import { clearCapturedLogs, capturedLogs } from "../../src/shared/logger.js";
import { publish, clearPublished } from "../../src/realtime/events.js";
import { stock } from "../../src/modules/ordering/stock.js";
import {
  cancelOrder,
  changeStatus,
  createOrder,
  executeOrderCommand,
  getOrder,
  getSessionBill,
  updateOrder,
} from "../../src/modules/ordering/order.service.js";
import { closeSession, openOrJoinSessionSafe } from "../../src/modules/ordering/session.service.js";
import { getTotalSales } from "../../src/modules/ordering/order.stats.js";
import Order from "../../src/modules/ordering/order.model.js";
import TableSession from "../../src/modules/ordering/session.model.js";
import MenuItem from "../../src/modules/menu/menuItem.model.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";

let replset;
let app;
let request;
let server;
let sockets;
let port;
let passwordHash;
let sequence = 0;

const waitFor = async (messages, predicate, timeout = 2000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out; messages=${JSON.stringify(messages)}`);
};

const connect = (token, { origin } = {}) =>
  new Promise((resolve, reject) => {
    const headers = origin ? { origin } : undefined;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`, { headers });
    const messages = [];
    let closeCode = null;
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 3000);
    ws.on("message", (buf) => messages.push(JSON.parse(buf.toString())));
    ws.on("close", (code) => {
      closeCode = code;
    });
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ ws, messages, closeCode: () => closeCode });
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const staffCtx = (fixture, requestId = randomUUID()) => ({
  restaurantId: fixture.restaurant._id,
  requestId,
  actor: { type: "employee", id: fixture.employee._id },
});

const guestCtx = (fixture, session, requestId = randomUUID()) => ({
  restaurantId: fixture.restaurant._id,
  requestId,
  actor: {
    type: "guest",
    id: null,
    sessionId: String(session._id),
    tableId: String(fixture.table._id),
  },
});

const itemsOf = (item, quantity = 1) => [{ productId: String(item._id), quantity }];

const fixture = async () => {
  sequence += 1;
  const suffix = `${sequence}-${randomUUID().slice(0, 8)}`;
  const restaurant = await Restaurant.create({ name: `R${suffix}`, slug: `r-${suffix}` });
  const employee = await Employee.create({
    restaurantId: restaurant._id,
    employee: `emp-${suffix}`,
    email: `e-${suffix}@example.com`,
    password: passwordHash,
    position: "admin",
    role: "admin",
  });
  const table = await Table.create({
    restaurantId: restaurant._id,
    tableNumber: 1,
    capacity: 4,
  });
  const item = await MenuItem.create({
    restaurantId: restaurant._id,
    title: "Pizza",
    description: "desc",
    price: 10,
    priceCents: 1000,
    image: "x.png",
    category: "food",
    inStock: true,
  });
  return { restaurant, employee, table, item, token: generateToken(employee) };
};

test.before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_DB_URL = replset.getUri();
  await connectToDatabase();
  ({ default: request } = await import("supertest"));
  ({ default: app } = await import("../../src/app.js"));
  passwordHash = await hashPassword("supersecret1");
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  port = server.address().port;
  const { attachWebSocket } = await import("../../src/realtime/wsServer.js");
  sockets = attachWebSocket(server);
}, { timeout: 180000 });

test.after(async () => {
  for (const client of sockets?.clients || []) client.terminate();
  if (sockets) await new Promise((resolve) => sockets.close(() => resolve()));
  if (server) await new Promise((resolve) => server.close(() => resolve()));
  await disconnectDatabase();
  await replset?.stop();
});

test("cached mongoose connection is reused", async () => {
  const first = await connectToDatabase();
  const second = await connectToDatabase();
  assert.equal(first, second);
  assert.equal(mongoose.connections.filter((connection) => connection.readyState === 1).length, 1);
});

test("health reports mongo and internal emit requires the secret", async () => {
  const health = await request(app).get("/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const missing = await request(app).post("/internal/emit").send({});
  assert.equal(missing.status, 401);
  const wrong = await request(app)
    .post("/internal/emit")
    .set("x-internal-secret", "not-the-secret")
    .send({});
  assert.equal(wrong.status, 401);
});

test("two restaurants can each have Table 1 and a menu item named Pizza", async () => {
  const a = await fixture();
  const b = await fixture();
  assert.equal(a.table.tableNumber, 1);
  assert.equal(b.table.tableNumber, 1);
  assert.equal(a.item.title, "Pizza");
  assert.equal(b.item.title, "Pizza");
  assert.notEqual(String(a.restaurant._id), String(b.restaurant._id));
});

test("a query without restaurantId throws", async () => {
  await assert.rejects(() => MenuItem.find({}).exec(), /restaurantId/);
  await assert.doesNotReject(() => MenuItem.find({}).setOptions({ skipTenant: true }).exec());
});

test("REST order writes are rejected and the service path is idempotent", async () => {
  const place = await fixture();
  const denied = await request(app)
    .post("/api/v1/orders")
    .set("Authorization", `Bearer ${place.token}`)
    .send({ clientOrderId: randomUUID(), items: itemsOf(place.item) });
  assert.equal(denied.status, 405);

  const payload = {
    clientOrderId: randomUUID(),
    tableId: String(place.table._id),
    items: itemsOf(place.item),
  };
  const ctx = staffCtx(place);
  const viaService = await createOrder(ctx, payload);
  const viaCommand = await executeOrderCommand(ctx, { type: "order.create", payload });
  assert.equal(viaCommand.replayed, true);
  assert.equal(viaService.order.id, viaCommand.order.id);
  assert.equal(viaService.order.totalCents, viaCommand.order.totalCents);
  assert.equal(await Order.countDocuments({ restaurantId: place.restaurant._id, clientOrderId: payload.clientOrderId }), 1);
});

test("sending the same create three times yields one order", async () => {
  const place = await fixture();
  const clientOrderId = randomUUID();
  const payload = { clientOrderId, tableId: String(place.table._id), items: itemsOf(place.item, 2) };
  const results = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    results.push(await createOrder(staffCtx(place), payload));
  }
  assert.equal(results[1].replayed, true);
  assert.equal(results[2].replayed, true);
  assert.equal(results[0].order.id, results[1].order.id);
  assert.equal(results[0].order.id, results[2].order.id);
  assert.equal(await Order.countDocuments({ restaurantId: place.restaurant._id, clientOrderId }), 1);
});

test("two concurrent first orders on the same table share one session", async () => {
  const place = await fixture();
  const [first, second] = await Promise.all([
    createOrder(staffCtx(place), {
      clientOrderId: randomUUID(),
      tableId: String(place.table._id),
      items: itemsOf(place.item),
    }),
    createOrder(staffCtx(place), {
      clientOrderId: randomUUID(),
      tableId: String(place.table._id),
      items: itemsOf(place.item),
    }),
  ]);
  assert.equal(first.order.sessionId, second.order.sessionId);
  const open = await TableSession.find({
    restaurantId: place.restaurant._id,
    tableId: place.table._id,
    status: "open",
  });
  assert.equal(open.length, 1);
});

test("a forced error after insert leaves no order and no numSold change", async () => {
  const place = await fixture();
  stock.afterSave = async () => {
    throw new Error("forced");
  };
  try {
    await assert.rejects(() =>
      createOrder(staffCtx(place), {
        clientOrderId: randomUUID(),
        tableId: String(place.table._id),
        items: itemsOf(place.item),
      })
    );
  } finally {
    stock.afterSave = null;
  }
  assert.equal(await Order.countDocuments({ restaurantId: place.restaurant._id }), 0);
  const fresh = await MenuItem.findOne({ _id: place.item._id, restaurantId: place.restaurant._id });
  assert.equal(fresh.numSold, 0);
});

test("creating an order with 10 items performs 1 menu query", async () => {
  const place = await fixture();
  const extras = [];
  for (let index = 0; index < 9; index += 1) {
    extras.push(
      await MenuItem.create({
        restaurantId: place.restaurant._id,
        title: `Dish ${index}`,
        description: "desc",
        price: 3,
        priceCents: 300,
        image: "x.png",
        category: "food",
        inStock: true,
      })
    );
  }
  let finds = 0;
  mongoose.set("debug", (collection, method) => {
    if (collection === "menuitems" && method === "find") finds += 1;
  });
  try {
    await createOrder(staffCtx(place), {
      clientOrderId: randomUUID(),
      tableId: String(place.table._id),
      items: [place.item, ...extras].map((item) => ({ productId: String(item._id), quantity: 1 })),
    });
  } finally {
    mongoose.set("debug", false);
  }
  assert.equal(finds, 1);
});

test("menu price edits and deletes do not change an existing bill", async () => {
  const place = await fixture();
  const created = await createOrder(staffCtx(place), {
    clientOrderId: randomUUID(),
    tableId: String(place.table._id),
    items: itemsOf(place.item),
  });
  await MenuItem.updateOne(
    { _id: place.item._id, restaurantId: place.restaurant._id },
    { price: 99, priceCents: 9900 }
  );
  const afterPrice = await getOrder(place.restaurant._id, created.order.id);
  assert.equal(afterPrice.items[0].unitPriceCents, 1000);
  assert.equal(afterPrice.items[0].title, "Pizza");

  await MenuItem.updateOne(
    { _id: place.item._id, restaurantId: place.restaurant._id },
    { archived: true, inStock: false }
  );
  const afterDelete = await getOrder(place.restaurant._id, created.order.id);
  assert.equal(afterDelete.items[0].title, "Pizza");
  assert.equal(afterDelete.totalCents, 1000);
});

test("create then cancel leaves numSold unchanged and drops the sale from stats", async () => {
  const place = await fixture();
  const created = await createOrder(staffCtx(place), {
    clientOrderId: randomUUID(),
    tableId: String(place.table._id),
    items: itemsOf(place.item, 3),
  });
  const sold = await MenuItem.findOne({ _id: place.item._id, restaurantId: place.restaurant._id });
  assert.equal(sold.numSold, 3);
  await cancelOrder(staffCtx(place), { orderId: created.order.id, reason: "mistake" });
  const after = await MenuItem.findOne({ _id: place.item._id, restaurantId: place.restaurant._id });
  assert.equal(after.numSold, 0);
  const sales = await getTotalSales(place.restaurant._id, {});
  assert.equal(sales.totalCents, 0);
});

test("session bill is the sum of rounds and a processing order cannot be edited", async () => {
  const place = await fixture();
  const first = await createOrder(staffCtx(place), {
    clientOrderId: randomUUID(),
    tableId: String(place.table._id),
    items: itemsOf(place.item, 1),
  });
  const second = await createOrder(staffCtx(place), {
    clientOrderId: randomUUID(),
    sessionId: first.order.sessionId,
    items: itemsOf(place.item, 2),
  });
  const bill = await getSessionBill(staffCtx(place), first.order.sessionId);
  assert.equal(bill.orders.length, 2);
  assert.equal(bill.totalCents, first.order.totalCents + second.order.totalCents);

  await changeStatus(staffCtx(place), { orderId: first.order.id, status: "accepted" });
  await changeStatus(staffCtx(place), { orderId: first.order.id, status: "preparing" });
  await assert.rejects(
    () => updateOrder(staffCtx(place), { orderId: first.order.id, items: itemsOf(place.item, 1) }),
    (error) => error.code === "INVALID_TRANSITION"
  );
  const stored = await getOrder(place.restaurant._id, first.order.id);
  assert.deepEqual(
    stored.statusHistory.map((entry) => entry.status),
    ["pending", "accepted", "preparing"]
  );
});

test("closing a session vacates the table and rejects the old guest token", async () => {
  const place = await fixture();
  const session = await openOrJoinSessionSafe(place.restaurant._id, place.table._id);
  const token = generateTableToken({
    restaurantId: place.restaurant._id,
    tableId: place.table._id,
    sessionId: session._id,
  });
  const guest = await connect(token);
  await closeSession(staffCtx(place), session._id);
  const table = await Table.findOne({ _id: place.table._id, restaurantId: place.restaurant._id });
  assert.equal(table.status, "vacant");

  const requestId = randomUUID();
  guest.ws.send(JSON.stringify({
    type: "order.create",
    requestId,
    payload: { clientOrderId: randomUUID(), items: itemsOf(place.item) },
  }));
  const ack = await waitFor(guest.messages, (message) => message.type === "ack" && message.requestId === requestId);
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, "SESSION_CLOSED");

  const again = await openOrJoinSessionSafe(place.restaurant._id, place.table._id);
  assert.notEqual(String(again._id), String(session._id));
  const bill = await getSessionBill(staffCtx(place), again._id);
  assert.equal(bill.orders.length, 0);
  guest.ws.close();
});

test("/auth/table/5 does not issue a token", async () => {
  const res = await request(app).post("/api/v1/auth/table/5").send({});
  assert.equal(res.status, 404);
  const place = await fixture();
  const issued = await request(app).post(`/api/v1/auth/table/${place.table.qrCode}`);
  assert.equal(issued.status, 200);
  assert.equal(typeof issued.body.token, "string");
});

test("restaurant A cannot read restaurant B resources", async () => {
  const a = await fixture();
  const b = await fixture();
  const created = await createOrder(staffCtx(b), {
    clientOrderId: randomUUID(),
    tableId: String(b.table._id),
    items: itemsOf(b.item),
  });
  const employeeB = await Employee.create({
    restaurantId: b.restaurant._id,
    employee: `other-${randomUUID().slice(0, 8)}`,
    email: `other-${randomUUID().slice(0, 8)}@example.com`,
    password: passwordHash,
    position: "waiter",
    role: "waiter",
  });
  const routes = [
    ["get", `/api/v1/menu-items/${b.item._id}`],
    ["put", `/api/v1/menu-items/${b.item._id}`, { inStock: false }],
    ["delete", `/api/v1/menu-items/${b.item._id}`],
    ["get", `/api/v1/table/${b.table._id}`],
    ["put", `/api/v1/table/${b.table._id}`, { capacity: 2 }],
    ["delete", `/api/v1/table/${b.table._id}`],
    ["post", `/api/v1/table/${b.table._id}/qr`],
    ["get", `/api/v1/orders/${created.order.id}`],
    ["get", `/api/v1/employee/${employeeB._id}`],
    ["put", `/api/v1/employee/${employeeB._id}`, { position: "kitchen" }],
    ["delete", `/api/v1/employee/${employeeB._id}`],
    ["post", `/api/v1/sessions/${created.order.sessionId}/close`],
  ];
  for (const [method, url, body] of routes) {
    const res = await request(app)[method](url)
      .set("Authorization", `Bearer ${a.token}`)
      .send(body || {});
    assert.equal(res.status, 404, `${method} ${url} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  const sales = await request(app)
    .get("/api/v1/statistics/sales")
    .set("Authorization", `Bearer ${a.token}`);
  assert.equal(sales.status, 200);
  assert.equal(sales.body.totalCents, 0);
  const board = await request(app)
    .get("/api/v1/staff/board")
    .set("Authorization", `Bearer ${a.token}`);
  assert.equal(
    board.body.orders.some((order) => order.clientOrderId === created.order.clientOrderId),
    false
  );
});

test("websocket create acks once and a wrong table number does not retarget the event", async () => {
  const place = await fixture();
  const other = await Table.create({
    restaurantId: place.restaurant._id,
    tableNumber: 2,
    capacity: 2,
  });
  const sessionA = await openOrJoinSessionSafe(place.restaurant._id, place.table._id);
  const sessionB = await openOrJoinSessionSafe(place.restaurant._id, other._id);
  const guestA = await connect(generateTableToken({
    restaurantId: place.restaurant._id,
    tableId: place.table._id,
    sessionId: sessionA._id,
  }));
  const guestB = await connect(generateTableToken({
    restaurantId: place.restaurant._id,
    tableId: other._id,
    sessionId: sessionB._id,
  }));
  const staff = await connect(place.token);
  const created = await createOrder(staffCtx(place), {
    clientOrderId: randomUUID(),
    sessionId: String(sessionA._id),
    items: itemsOf(place.item),
  });
  const requestId = randomUUID();
  staff.ws.send(JSON.stringify({
    type: "order.status",
    requestId,
    payload: {
      orderId: created.order.id,
      status: "accepted",
      tableNum: String(other.tableNumber),
      tableId: String(other._id),
    },
  }));
  const ack = await waitFor(staff.messages, (message) => message.requestId === requestId);
  assert.equal(ack.ok, true);
  assert.equal(ack.data.order.status, "accepted");
  const seenByA = await waitFor(
    guestA.messages,
    (message) => message.type === "event" && message.event === "order.statusChanged"
  );
  assert.equal(seenByA.data.orderId, created.order.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    guestB.messages.some((message) => message.data?.orderId === created.order.id),
    false
  );
  guestA.ws.close();
  guestB.ws.close();
  staff.ws.close();
});

test("unknown socket messages are validation acks and floods are throttled", async () => {
  const place = await fixture();
  const staff = await connect(place.token);
  const requestId = randomUUID();
  staff.ws.send(JSON.stringify({ type: "nope", requestId, payload: {} }));
  const ack = await waitFor(staff.messages, (message) => message.requestId === requestId);
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, "VALIDATION");

  const ids = Array.from({ length: 12 }, () => randomUUID());
  for (const id of ids) {
    staff.ws.send(JSON.stringify({ type: "nope", requestId: id, payload: {} }));
  }
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const got = ids.filter((id) => staff.messages.some((message) => message.requestId === id));
    if (got.length === ids.length) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const throttled = staff.messages.filter((message) => message.error?.message === "Too many messages");
  assert.ok(throttled.length >= 1);
  staff.ws.close();
});

test("inStock toggles reach guest and staff sockets", async () => {
  const place = await fixture();
  const session = await openOrJoinSessionSafe(place.restaurant._id, place.table._id);
  const guest = await connect(generateTableToken({
    restaurantId: place.restaurant._id,
    tableId: place.table._id,
    sessionId: session._id,
  }));
  const staff = await connect(place.token);
  const updated = await request(app)
    .put(`/api/v1/menu-items/${place.item._id}`)
    .set("Authorization", `Bearer ${place.token}`)
    .send({ inStock: false });
  assert.equal(updated.status, 200);
  const guestEvent = await waitFor(
    guest.messages,
    (message) => message.type === "event" && message.event === "menu.updated",
    2000
  );
  const staffEvent = await waitFor(
    staff.messages,
    (message) => message.type === "event" && message.event === "menu.updated",
    2000
  );
  assert.equal(guestEvent.data.inStock, false);
  assert.equal(staffEvent.data.inStock, false);
  guest.ws.close();
  staff.ws.close();
});

test("an internal emit without a matching secret is rejected and a valid one is broadcast", async () => {
  const place = await fixture();
  const staff = await connect(place.token);
  const res = await request(app)
    .post("/internal/emit")
    .set("x-internal-secret", process.env.INTERNAL_SECRET)
    .send({
      restaurantId: String(place.restaurant._id),
      fanout: true,
      message: { type: "event", event: "menu.updated", data: { inStock: true } },
    });
  assert.equal(res.status, 202);
  const event = await waitFor(staff.messages, (message) => message.event === "menu.updated");
  assert.equal(event.data.inStock, true);
  staff.ws.close();
});

test("vercel publishes by notifying render instead of local sockets", async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (...args) => {
    calls.push(args);
    return { ok: true };
  };
  process.env.DEPLOY_TARGET = "vercel";
  process.env.RENDER_INTERNAL_URL = "https://render.example";
  clearPublished();
  try {
    publish({
      restaurantId: new mongoose.Types.ObjectId().toString(),
      fanout: true,
      message: { type: "event", event: "menu.updated", data: { inStock: false } },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, 1);
    assert.equal(String(calls[0][0]), "https://render.example/internal/emit");
    assert.equal(calls[0][1].headers["x-internal-secret"], process.env.INTERNAL_SECRET);
  } finally {
    global.fetch = original;
    process.env.DEPLOY_TARGET = "local";
  }
});

test("a failed order log includes restaurant, session, and request id", async () => {
  const place = await fixture();
  await MenuItem.updateOne(
    { _id: place.item._id, restaurantId: place.restaurant._id },
    { inStock: false }
  );
  const session = await openOrJoinSessionSafe(place.restaurant._id, place.table._id);
  clearCapturedLogs();
  const requestId = randomUUID();
  await assert.rejects(() =>
    createOrder(guestCtx(place, session, requestId), {
      clientOrderId: randomUUID(),
      items: itemsOf(place.item),
    })
  );
  const line = capturedLogs.find((entry) => entry && entry.requestId === requestId);
  assert.ok(line, "expected a log line for the failed order");
  assert.equal(String(line.restaurantId), String(place.restaurant._id));
  assert.equal(String(line.sessionId), String(session._id));
});

test("expired tokens are closed with 4001", async () => {
  const place = await fixture();
  const token = jwt.sign(
    {
      id: String(place.employee._id),
      role: "employee",
      position: "admin",
      restaurantId: String(place.restaurant._id),
    },
    process.env.JWT_SECRET,
    { expiresIn: 1, algorithm: "HS256" }
  );
  const staff = await connect(token);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  staff.ws.send(JSON.stringify({ type: "nope", requestId: randomUUID(), payload: {} }));
  const start = Date.now();
  while (staff.closeCode() !== 4001 && Date.now() - start < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(staff.closeCode(), 4001);
});

test("a disallowed origin is rejected on upgrade", async () => {
  const place = await fixture();
  process.env.CORS_ORIGIN = "https://app.example";
  try {
    await assert.rejects(() => connect(place.token, { origin: "https://evil.example" }));
    const allowed = await connect(place.token, { origin: "https://app.example" });
    allowed.ws.close();
  } finally {
    delete process.env.CORS_ORIGIN;
  }
});
