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
import { publish, clearPublished, published } from "../../src/realtime/events.js";
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
import User from "../../src/modules/staff/user.model.js";
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

const openSocket = (search, { origin } = {}) =>
  new Promise((resolve, reject) => {
    const headers = origin ? { origin } : undefined;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${search}`, { headers });
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
      if (ws.readyState !== WebSocket.OPEN) reject(error);
    });
  });

const connect = (token, { origin, query } = {}) =>
  openSocket([`token=${encodeURIComponent(token)}`, query].filter(Boolean).join("&"), { origin });

const ask = async (client, type, payload) => {
  const requestId = randomUUID();
  client.ws.send(JSON.stringify({ type, requestId, payload }));
  return waitFor(client.messages, (message) => message.type === "ack" && message.requestId === requestId);
};

const waitForClose = async (client, code, timeout = 2000) => {
  const start = Date.now();
  while (client.closeCode() !== code && Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return client.closeCode();
};

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
  assert.equal(viaService.order._id, viaCommand.order._id);
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
  assert.equal(results[0].order._id, results[1].order._id);
  assert.equal(results[0].order._id, results[2].order._id);
  assert.equal(await Order.countDocuments({ restaurantId: place.restaurant._id, clientOrderId }), 1);
});

test("two concurrent first orders on the same table share one session", async () => {
  const place = await fixture();
  clearPublished();
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
  assert.equal(published.filter((entry) => entry.message?.event === "session.opened").length, 1);
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
  const afterPrice = await getOrder(place.restaurant._id, created.order._id);
  assert.equal(afterPrice.items[0].unitPriceCents, 1000);
  assert.equal(afterPrice.items[0].title, "Pizza");

  await MenuItem.updateOne(
    { _id: place.item._id, restaurantId: place.restaurant._id },
    { archived: true, inStock: false }
  );
  const afterDelete = await getOrder(place.restaurant._id, created.order._id);
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
  const cancelled = await cancelOrder(staffCtx(place), { orderId: created.order._id, reason: "mistake" });
  assert.equal(cancelled.order.rev, 2);
  assert.equal(cancelled.order.status, "cancelled");
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

  assert.equal(first.order.rev, 1);
  const accepted = await changeStatus(staffCtx(place), { orderId: first.order._id, status: "accepted" });
  assert.equal(accepted.order.rev, 2);
  const preparing = await changeStatus(staffCtx(place), { orderId: first.order._id, status: "preparing" });
  assert.equal(preparing.order.rev, 3);
  await assert.rejects(
    () => updateOrder(staffCtx(place), { orderId: first.order._id, items: itemsOf(place.item, 1) }),
    (error) => error.code === "INVALID_TRANSITION" && error.details.from === "preparing"
  );
  const stored = await Order.findOne({ _id: first.order._id, restaurantId: place.restaurant._id });
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
  const staff = await connect(place.token);
  await closeSession(staffCtx(place), session._id);
  const table = await Table.findOne({ _id: place.table._id, restaurantId: place.restaurant._id });
  assert.equal(table.status, "vacant");

  const closed = await waitFor(guest.messages, (message) => message.event === "session.closed");
  assert.equal(closed.data.sessionId, String(session._id));
  assert.equal(await waitForClose(guest, 4004), 4004);
  assert.equal(staff.ws.readyState, WebSocket.OPEN);
  assert.equal(staff.closeCode(), null);

  const late = await connect(token);
  assert.equal(await waitForClose(late, 4004), 4004);

  const again = await openOrJoinSessionSafe(place.restaurant._id, place.table._id);
  assert.notEqual(String(again._id), String(session._id));
  const bill = await getSessionBill(staffCtx(place), again._id);
  assert.equal(bill.orders.length, 0);
  staff.ws.close();
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
    ["get", `/api/v1/orders/${created.order._id}`],
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
      orderId: created.order._id,
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
  assert.equal(seenByA.data.orderId, created.order._id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    guestB.messages.some((message) => message.data?.orderId === created.order._id),
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
  const throttled = staff.messages.filter((message) => message.error?.code === "RATE_LIMITED");
  assert.ok(throttled.length >= 1);
  assert.equal(typeof throttled[0].error.details.retryAfterMs, "number");
  assert.equal(await waitForClose(staff, 4008), 4008);
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

test("acks, events, and the staff board share one order shape", async () => {
  const place = await fixture();
  const staff = await connect(place.token);
  const clientOrderId = randomUUID();
  const ack = await ask(staff, "order.create", {
    clientOrderId,
    tableId: String(place.table._id),
    items: itemsOf(place.item, 2),
  });
  assert.equal(ack.ok, true);
  const openedAt = staff.messages.findIndex((message) => message.event === "session.opened");
  const createdAt = staff.messages.findIndex(
    (message) => message.event === "order.created" && message.data.order?.clientOrderId === clientOrderId
  );
  assert.ok(openedAt >= 0 && createdAt > openedAt);
  assert.equal(staff.messages[openedAt].data.session.status, "open");
  assert.equal(staff.messages[openedAt].data.session.tableNumber, place.table.tableNumber);
  assert.equal(staff.messages[openedAt].data.session.closedAt, null);

  const eventOrder = staff.messages[createdAt].data.order;
  const board = await request(app)
    .get("/api/v1/staff/board")
    .set("Authorization", `Bearer ${place.token}`);
  const boardOrder = board.body.orders.find((order) => order._id === ack.data.order._id);
  assert.equal(JSON.stringify(eventOrder), JSON.stringify(ack.data.order));
  assert.equal(JSON.stringify(boardOrder), JSON.stringify(ack.data.order));
  assert.equal(ack.data.order.rev, 1);
  assert.equal(ack.data.order.__v, undefined);
  assert.equal(ack.data.order.items[0].status, undefined);
  assert.match(ack.data.order.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(board.body.sessions[0]._id, ack.data.order.sessionId);
  assert.equal(board.body.sessions[0].__v, undefined);
  staff.ws.close();
});

test("resending order.create returns the same ack and emits order.created once", async () => {
  const place = await fixture();
  const staff = await connect(place.token);
  const clientOrderId = randomUUID();
  const payload = {
    clientOrderId,
    tableId: String(place.table._id),
    items: itemsOf(place.item),
  };
  const acks = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    acks.push(await ask(staff, "order.create", payload));
  }
  assert.equal(acks.every((ack) => ack.ok), true);
  assert.equal(JSON.stringify(acks[1].data.order), JSON.stringify(acks[0].data.order));
  assert.equal(JSON.stringify(acks[2].data.order), JSON.stringify(acks[0].data.order));
  const created = staff.messages.filter(
    (message) => message.event === "order.created" && message.data.order?.clientOrderId === clientOrderId
  );
  assert.equal(created.length, 1);
  assert.equal(await Order.countDocuments({ restaurantId: place.restaurant._id, clientOrderId }), 1);
  staff.ws.close();
});

test("out of stock, validation, and permission errors include structured details", async () => {
  const place = await fixture();
  const other = await Table.create({
    restaurantId: place.restaurant._id,
    tableNumber: 8,
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

  await MenuItem.updateOne(
    { _id: place.item._id, restaurantId: place.restaurant._id },
    { inStock: false }
  );
  const stockAck = await ask(guestA, "order.create", {
    clientOrderId: randomUUID(),
    items: itemsOf(place.item),
  });
  assert.equal(stockAck.ok, false);
  assert.equal(stockAck.error.code, "OUT_OF_STOCK");
  assert.deepEqual(stockAck.error.details.productIds, [String(place.item._id)]);
  await MenuItem.updateOne(
    { _id: place.item._id, restaurantId: place.restaurant._id },
    { inStock: true }
  );

  const zero = await ask(staff, "order.create", {
    clientOrderId: randomUUID(),
    tableId: String(place.table._id),
    items: [{ productId: String(place.item._id), quantity: 0 }],
  });
  assert.equal(zero.error.code, "VALIDATION");
  assert.equal(zero.error.details.fields["items.0.quantity"], "must be >= 1");

  const tooMany = await ask(staff, "order.create", {
    clientOrderId: randomUUID(),
    tableId: String(place.table._id),
    items: [{ productId: String(place.item._id), quantity: 100 }],
  });
  assert.equal(tooMany.error.code, "VALIDATION");
  assert.equal(tooMany.error.details.fields["items.0.quantity"], "must be <= 99");

  const notes = await ask(staff, "order.create", {
    clientOrderId: randomUUID(),
    tableId: String(place.table._id),
    items: [{ productId: String(place.item._id), quantity: 1, notes: "n".repeat(201) }],
  });
  assert.equal(notes.error.code, "VALIDATION");
  assert.equal(notes.error.details.fields["items.0.notes"], "must be at most 200 characters");

  const items = Array.from({ length: 51 }, () => ({
    productId: new mongoose.Types.ObjectId().toString(),
    quantity: 1,
  }));
  const oversized = await ask(staff, "order.create", {
    clientOrderId: randomUUID(),
    tableId: String(place.table._id),
    items,
  });
  assert.equal(oversized.error.code, "VALIDATION");
  assert.equal(oversized.error.details.fields.items, "must contain at most 50 items");
  staff.ws.close();
  const orders = await connect(place.token);

  const missingTarget = await ask(orders, "order.create", {
    clientOrderId: randomUUID(),
    items: itemsOf(place.item),
  });
  assert.equal(missingTarget.error.code, "VALIDATION");

  const guestOrder = await ask(guestA, "order.create", {
    clientOrderId: randomUUID(),
    sessionId: String(sessionB._id),
    tableId: String(other._id),
    items: itemsOf(place.item),
  });
  assert.equal(guestOrder.ok, true);
  assert.equal(guestOrder.data.order.sessionId, String(sessionA._id));

  const staffOnTable = await ask(orders, "order.create", {
    clientOrderId: randomUUID(),
    tableId: String(place.table._id),
    items: itemsOf(place.item),
  });
  assert.equal(staffOnTable.ok, true);
  assert.equal(staffOnTable.data.order.sessionId, String(sessionA._id));

  const staffOnSession = await ask(orders, "order.create", {
    clientOrderId: randomUUID(),
    sessionId: String(sessionB._id),
    items: itemsOf(place.item),
  });
  assert.equal(staffOnSession.ok, true);
  assert.equal(staffOnSession.data.order.sessionId, String(sessionB._id));

  const guestEdit = await ask(guestA, "order.update", {
    orderId: guestOrder.data.order._id,
    items: itemsOf(place.item, 2),
  });
  assert.equal(guestEdit.ok, true);
  assert.equal(guestEdit.data.order.rev, guestOrder.data.order.rev + 1);

  const foreignEdit = await ask(guestB, "order.update", {
    orderId: guestOrder.data.order._id,
    items: itemsOf(place.item, 1),
  });
  assert.equal(foreignEdit.ok, false);
  assert.equal(foreignEdit.error.code, "NOT_FOUND");

  const staffEdit = await ask(orders, "order.update", {
    orderId: staffOnTable.data.order._id,
    items: itemsOf(place.item, 2),
  });
  assert.equal(staffEdit.ok, true);

  const guestStatus = await ask(guestA, "order.status", {
    orderId: guestOrder.data.order._id,
    status: "accepted",
  });
  assert.equal(guestStatus.error.code, "FORBIDDEN");

  const accepted = await ask(orders, "order.status", {
    orderId: staffOnTable.data.order._id,
    status: "accepted",
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.data.order.rev, staffEdit.data.order.rev + 1);
  assert.equal(
    orders.messages.find((message) => message.data?.orderId === staffOnTable.data.order._id && message.event === "order.statusChanged").data.rev,
    accepted.data.order.rev
  );

  const guestEditAccepted = await ask(guestA, "order.update", {
    orderId: staffOnTable.data.order._id,
    items: itemsOf(place.item, 1),
  });
  assert.equal(guestEditAccepted.error.code, "INVALID_TRANSITION");
  assert.equal(guestEditAccepted.error.details.from, "accepted");

  const staffEditAccepted = await ask(orders, "order.update", {
    orderId: staffOnTable.data.order._id,
    items: itemsOf(place.item, 1),
  });
  assert.equal(staffEditAccepted.error.code, "INVALID_TRANSITION");

  const guestCancelAccepted = await ask(guestA, "order.cancel", {
    orderId: staffOnTable.data.order._id,
    reason: "too late",
  });
  assert.equal(guestCancelAccepted.error.code, "INVALID_TRANSITION");
  assert.deepEqual(guestCancelAccepted.error.details, { from: "accepted", to: "cancelled" });

  const staffCancelAccepted = await ask(orders, "order.cancel", {
    orderId: staffOnTable.data.order._id,
    reason: "comp",
  });
  assert.equal(staffCancelAccepted.ok, true);
  assert.equal(staffCancelAccepted.data.order.status, "cancelled");

  const guestCancel = await ask(guestA, "order.cancel", {
    orderId: guestOrder.data.order._id,
    reason: "changed mind",
  });
  assert.equal(guestCancel.ok, true);
  const guestCancelEvent = guestA.messages.find(
    (message) => message.event === "order.statusChanged" && message.data?.orderId === guestOrder.data.order._id
  );
  assert.equal(guestCancelEvent.data.status, "cancelled");
  assert.equal(guestCancelEvent.data.reason, "changed mind");

  const foreignCancel = await ask(guestA, "order.cancel", {
    orderId: staffOnSession.data.order._id,
    reason: "nope",
  });
  assert.equal(foreignCancel.error.code, "NOT_FOUND");

  orders.ws.close();
  const later = await connect(place.token);
  const preparing = await ask(later, "order.create", {
    clientOrderId: randomUUID(),
    sessionId: String(sessionB._id),
    items: itemsOf(place.item),
  });
  await ask(later, "order.status", { orderId: preparing.data.order._id, status: "accepted" });
  await ask(later, "order.status", { orderId: preparing.data.order._id, status: "preparing" });
  const cancelPreparing = await ask(later, "order.cancel", {
    orderId: preparing.data.order._id,
    reason: "burnt",
  });
  assert.equal(cancelPreparing.error.code, "INVALID_TRANSITION");
  assert.deepEqual(cancelPreparing.error.details, { from: "preparing", to: "cancelled" });

  const staffCancelPending = await ask(later, "order.cancel", {
    orderId: staffOnSession.data.order._id,
    reason: "guest left",
  });
  assert.equal(staffCancelPending.ok, true);
  assert.equal(staffCancelPending.data.order.status, "cancelled");

  guestA.ws.close();
  guestB.ws.close();
  later.ws.close();
});

test("the 11th message within 10s is RATE_LIMITED", async () => {
  const place = await fixture();
  const staff = await connect(place.token);
  const ids = Array.from({ length: 11 }, () => randomUUID());
  for (const id of ids) {
    staff.ws.send(JSON.stringify({ type: "nope", requestId: id, payload: {} }));
  }
  const last = await waitFor(staff.messages, (message) => message.requestId === ids[10]);
  assert.equal(last.error.code, "RATE_LIMITED");
  assert.ok(last.error.details.retryAfterMs > 0);
  const tenth = staff.messages.find((message) => message.requestId === ids[9]);
  assert.equal(tenth.error.code, "VALIDATION");
  staff.ws.close();
});

test("a message larger than 16 KB closes the socket with 1009", async () => {
  const place = await fixture();
  const staff = await connect(place.token);
  staff.ws.send("x".repeat(17 * 1024));
  assert.equal(await waitForClose(staff, 1009, 3000), 1009);
});

test("a menu price change reaches guest sockets as menu.updated", async () => {
  const place = await fixture();
  const session = await openOrJoinSessionSafe(place.restaurant._id, place.table._id);
  const guest = await connect(generateTableToken({
    restaurantId: place.restaurant._id,
    tableId: place.table._id,
    sessionId: session._id,
  }));
  const updated = await request(app)
    .put(`/api/v1/menu-items/${place.item._id}`)
    .set("Authorization", `Bearer ${place.token}`)
    .send({ price: 12.5 });
  assert.equal(updated.status, 200);
  const event = await waitFor(guest.messages, (message) => message.event === "menu.updated");
  assert.equal(event.data._id, String(place.item._id));
  assert.equal(event.data.priceCents, 1250);
  assert.equal(event.data.title, "Pizza");
  assert.equal(event.data.inStock, true);
  assert.equal(event.data.category, "food");
  assert.equal(event.data.archived, false);
  guest.ws.close();
});

test("websocket tickets expire in 60s and reject a normal API JWT", async () => {
  const place = await fixture();
  const issued = await request(app)
    .post("/api/v1/ws-ticket")
    .set("Authorization", `Bearer ${place.token}`);
  assert.equal(issued.status, 200);
  const decoded = jwt.verify(issued.body.ticket, process.env.JWT_SECRET);
  assert.equal(decoded.purpose, "ws");
  assert.ok(decoded.exp - decoded.iat <= 60);

  const live = await openSocket(`ticket=${encodeURIComponent(issued.body.ticket)}`);
  assert.equal(live.ws.readyState, WebSocket.OPEN);
  live.ws.close();

  const rejected = await openSocket(`ticket=${encodeURIComponent(place.token)}`);
  assert.equal(await waitForClose(rejected, 4003), 4003);

  const expired = jwt.sign(
    {
      id: String(place.employee._id),
      role: "employee",
      restaurantId: String(place.restaurant._id),
      purpose: "ws",
      exp: Math.floor(Date.now() / 1000) - 10,
    },
    process.env.JWT_SECRET,
    { algorithm: "HS256" }
  );
  const old = await openSocket(`ticket=${encodeURIComponent(expired)}`);
  assert.equal(await waitForClose(old, 4001), 4001);
});

test("an unknown protocol version is closed with 4000", async () => {
  const place = await fixture();
  const client = await connect(place.token, { query: "v=99" });
  assert.equal(await waitForClose(client, 4000), 4000);
  const current = await connect(place.token, { query: "v=2" });
  current.ws.close();
});

const AUTHENTICATED_ROUTES = [
  "POST /api/v1/ws-ticket",
  "GET /api/v1/auth/user",
  "GET /api/v1/users",
  "GET /api/v1/users/:id",
  "PUT /api/v1/users/:id",
  "DELETE /api/v1/users/:id",
  "GET /api/v1/employee",
  "POST /api/v1/employee",
  "GET /api/v1/employee/:id",
  "PUT /api/v1/employee/:id",
  "DELETE /api/v1/employee/:id",
  "GET /api/v1/menu-items",
  "GET /api/v1/menu-items/category",
  "POST /api/v1/menu-items",
  "GET /api/v1/menu-items/:id",
  "PUT /api/v1/menu-items/:id",
  "DELETE /api/v1/menu-items/:id",
  "GET /api/v1/orders",
  "POST /api/v1/orders",
  "GET /api/v1/orders/:id",
  "PUT /api/v1/orders/:id",
  "PUT /api/v1/orders/:id/status",
  "DELETE /api/v1/orders/:id",
  "POST /api/v1/sessions/:id/close",
  "GET /api/v1/table",
  "POST /api/v1/table",
  "GET /api/v1/table/:id",
  "POST /api/v1/table/:id/qr",
  "PUT /api/v1/table/:id",
  "DELETE /api/v1/table/:id",
  "GET /api/v1/statistics/sales",
  "GET /api/v1/statistics/sales/menu-items",
  "GET /api/v1/statistics/orders/by-date",
  "GET /api/v1/statistics/customers/top",
  "GET /api/v1/statistics/:id/orders",
  "GET /api/v1/staff/board",
];

const joinPath = (prefix, path) => {
  const base = (prefix || "").replace(/\/$/, "");
  if (!path || path === "/") return base || "/";
  return `${base}/${path.replace(/^\//, "")}`.replace(/\/+/g, "/");
};

const layerPath = (layer) => {
  if (!layer.regexp || layer.regexp.fast_slash) return "";
  const cleaned = layer.regexp.source
    .replace(/^\^/, "")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\\(.)/g, "$1");
  return cleaned.startsWith("/") ? cleaned : "";
};

const collectAuthenticatedRoutes = (expressApp) => {
  const found = [];
  const walk = (stack, prefix, parentAuthenticated) => {
    const routerAuthenticated = parentAuthenticated || (stack || []).some((layer) => !layer.route && layer.name === "requireAuth");
    for (const layer of stack || []) {
      if (layer.route) {
        const routeAuthenticated = routerAuthenticated || layer.route.stack.some((entry) => entry.name === "requireAuth");
        if (!routeAuthenticated) continue;
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (!enabled) continue;
          found.push(`${method.toUpperCase()} ${joinPath(prefix, layer.route.path)}`);
        }
      } else if (Array.isArray(layer.handle?.stack)) {
        walk(layer.handle.stack, joinPath(prefix, layerPath(layer)), routerAuthenticated);
      }
    }
  };
  walk(expressApp._router.stack, "", false);
  return found.sort();
};

const PUBLIC_MENU_KEYS = new Set([
  "_id",
  "title",
  "description",
  "price",
  "priceCents",
  "image",
  "category",
  "inStock",
  "station",
  "popular",
]);

test("cross-tenant lists, creates, stats, public menu, and sockets stay inside restaurant A", async () => {
  const exercised = new Set();
  const cover = (method, path) => exercised.add(`${method} ${path}`);
  const a = await fixture();
  const b = await fixture();
  const tag = randomUUID().slice(0, 8);
  const hidden = await MenuItem.create({
    restaurantId: a.restaurant._id,
    title: `Hidden ${tag}`,
    description: "archived",
    price: 2,
    priceCents: 200,
    image: "h.png",
    category: "food",
    inStock: false,
    archived: true,
  });
  const secret = await MenuItem.create({
    restaurantId: b.restaurant._id,
    title: `Secret ${tag}`,
    description: "other restaurant",
    price: 8,
    priceCents: 800,
    image: "s.png",
    category: `secret-${tag}`,
    inStock: true,
  });
  const userA = await User.create({
    username: `ua${tag}`,
    email: `ua-${tag}@example.com`,
    password: passwordHash,
  });
  const userB = await User.create({
    username: `ub${tag}`,
    email: `ub-${tag}@example.com`,
    password: passwordHash,
  });
  const orderA = await createOrder(staffCtx(a), {
    clientOrderId: randomUUID(),
    tableId: String(a.table._id),
    items: itemsOf(a.item, 2),
  });
  const orderB = await createOrder(staffCtx(b), {
    clientOrderId: randomUUID(),
    tableId: String(b.table._id),
    items: itemsOf(b.item, 5),
  });
  await Order.updateOne(
    { _id: orderA.order._id, restaurantId: a.restaurant._id },
    { $set: { userId: userA._id } }
  );
  await Order.updateOne(
    { _id: orderB.order._id, restaurantId: b.restaurant._id },
    { $set: { userId: userB._id } }
  );
  const foreignIds = [
    b.restaurant._id,
    b.item._id,
    secret._id,
    b.table._id,
    b.employee._id,
    orderB.order._id,
    orderB.order.sessionId,
    userB._id,
  ].map(String);
  const asA = (method, url) => request(app)[method](url).set("Authorization", `Bearer ${a.token}`);
  const assertOnlyA = (body, expectedIds, label) => {
    const rows = Array.isArray(body) ? body : body.orders;
    assert.equal(rows.length, expectedIds.size, label);
    for (const row of rows) assert.equal(expectedIds.has(String(row._id)), true, label);
    const blob = JSON.stringify(body);
    for (const id of foreignIds) assert.equal(blob.includes(id), false, `${label} leaked ${id}`);
  };

  const menuIds = new Set(
    (await MenuItem.find({ restaurantId: a.restaurant._id, archived: false }).select("_id")).map((doc) => String(doc._id))
  );
  const menu = await asA("get", "/api/v1/menu-items");
  cover("GET", "/api/v1/menu-items");
  assert.equal(menu.status, 200);
  assertOnlyA(menu.body, menuIds, "menu");
  assert.equal(menu.body.some((item) => String(item._id) === String(hidden._id)), false);

  const categories = await asA("get", "/api/v1/menu-items/category");
  cover("GET", "/api/v1/menu-items/category");
  assert.equal(categories.status, 200);
  assert.equal(categories.body.includes(`secret-${tag}`), false);
  assert.deepEqual(categories.body.sort(), ["food"]);

  const tableIds = new Set(
    (await Table.find({ restaurantId: a.restaurant._id }).select("_id")).map((doc) => String(doc._id))
  );
  const tables = await asA("get", "/api/v1/table");
  cover("GET", "/api/v1/table");
  assert.equal(tables.status, 200);
  assertOnlyA(tables.body, tableIds, "tables");

  const employeeIds = new Set(
    (await Employee.find({ restaurantId: a.restaurant._id }).select("_id")).map((doc) => String(doc._id))
  );
  const employees = await asA("get", "/api/v1/employee");
  cover("GET", "/api/v1/employee");
  assert.equal(employees.status, 200);
  assertOnlyA(employees.body, employeeIds, "employees");

  const orderIds = new Set(
    (await Order.find({ restaurantId: a.restaurant._id }).select("_id")).map((doc) => String(doc._id))
  );
  const orders = await asA("get", "/api/v1/orders");
  cover("GET", "/api/v1/orders");
  assert.equal(orders.status, 200);
  assert.equal(orders.body.total, orderIds.size);
  assertOnlyA(orders.body, orderIds, "orders");

  const bMenuBefore = await MenuItem.countDocuments({ restaurantId: b.restaurant._id });
  const createdMenu = await asA("post", "/api/v1/menu-items").send({
    title: `Bisque ${tag}`,
    description: "soup",
    price: 4,
    image: "b.png",
    category: "food",
    restaurantId: String(b.restaurant._id),
  });
  cover("POST", "/api/v1/menu-items");
  assert.equal(createdMenu.status, 201);
  assert.equal(String(createdMenu.body.restaurantId), String(a.restaurant._id));
  assert.ok(await MenuItem.findOne({ _id: createdMenu.body._id, restaurantId: a.restaurant._id }));
  assert.equal(await MenuItem.countDocuments({ restaurantId: b.restaurant._id }), bMenuBefore);

  const bTablesBefore = await Table.countDocuments({ restaurantId: b.restaurant._id });
  const createdTable = await asA("post", "/api/v1/table").send({
    tableNumber: 80,
    capacity: 2,
    restaurantId: String(b.restaurant._id),
  });
  cover("POST", "/api/v1/table");
  assert.equal(createdTable.status, 201);
  assert.equal(String(createdTable.body.restaurantId), String(a.restaurant._id));
  assert.ok(await Table.findOne({ _id: createdTable.body._id, restaurantId: a.restaurant._id }));
  assert.equal(await Table.countDocuments({ restaurantId: b.restaurant._id }), bTablesBefore);

  const bEmployeesBefore = await Employee.countDocuments({ restaurantId: b.restaurant._id });
  const createdEmployee = await asA("post", "/api/v1/employee").send({
    employee: `hire${tag}`,
    email: `hire-${tag}@example.com`,
    password: "supersecret1",
    position: "waiter",
    restaurantId: String(b.restaurant._id),
  });
  cover("POST", "/api/v1/employee");
  assert.equal(createdEmployee.status, 201);
  assert.equal(String(createdEmployee.body.restaurantId), String(a.restaurant._id));
  assert.ok(await Employee.findOne({ _id: createdEmployee.body._id, restaurantId: a.restaurant._id }));
  assert.equal(await Employee.countDocuments({ restaurantId: b.restaurant._id }), bEmployeesBefore);

  const sales = await asA("get", "/api/v1/statistics/sales");
  cover("GET", "/api/v1/statistics/sales");
  assert.equal(sales.status, 200);
  assert.equal(sales.body.totalCents, 2000);

  const byItem = await asA("get", "/api/v1/statistics/sales/menu-items");
  cover("GET", "/api/v1/statistics/sales/menu-items");
  assert.equal(byItem.status, 200);
  assert.equal(byItem.body.length, 1);
  assert.equal(byItem.body[0].menu_item, "Pizza");
  assert.equal(byItem.body[0].numSold, 2);
  assert.equal(JSON.stringify(byItem.body).includes(`Secret ${tag}`), false);

  const byDate = await asA("get", "/api/v1/statistics/orders/by-date");
  cover("GET", "/api/v1/statistics/orders/by-date");
  assert.equal(byDate.status, 200);
  assert.equal(byDate.body.reduce((sum, row) => sum + row.ordersCount, 0), 1);

  const top = await asA("get", "/api/v1/statistics/customers/top");
  cover("GET", "/api/v1/statistics/customers/top");
  assert.equal(top.status, 200);
  assert.deepEqual(top.body.map((row) => row.user), [userA.username]);

  const ownOrders = await asA("get", `/api/v1/statistics/${userA._id}/orders`);
  cover("GET", "/api/v1/statistics/:id/orders");
  assert.equal(ownOrders.status, 200);
  assert.equal(ownOrders.body.length, 1);
  assert.equal(String(ownOrders.body[0].restaurantId), String(a.restaurant._id));
  const foreignOrders = await asA("get", `/api/v1/statistics/${userB._id}/orders`);
  assert.equal(foreignOrders.status, 404);

  const publishedMenu = await request(app).get(`/api/v1/r/${a.restaurant.slug}/menu-items`);
  assert.equal(publishedMenu.status, 200);
  assert.equal(publishedMenu.body.length, menuIds.size + 1);
  for (const item of publishedMenu.body) {
    for (const key of Object.keys(item)) {
      assert.equal(PUBLIC_MENU_KEYS.has(key), true, `public menu leaked ${key}`);
    }
    assert.equal(item.numSold, undefined);
    assert.equal(item.restaurantId, undefined);
  }
  assert.equal(publishedMenu.body.some((item) => item.title === `Hidden ${tag}`), false);
  assert.equal(publishedMenu.body.some((item) => String(item._id) === String(b.item._id)), false);
  assert.equal(publishedMenu.body.some((item) => item.title === `Secret ${tag}`), false);
  const unknownSlug = await request(app).get(`/api/v1/r/missing-${tag}/menu-items`);
  assert.equal(unknownSlug.status, 404);

  const missing = [
    ["get", `/api/v1/menu-items/${b.item._id}`, "GET /api/v1/menu-items/:id"],
    ["put", `/api/v1/menu-items/${b.item._id}`, "PUT /api/v1/menu-items/:id"],
    ["delete", `/api/v1/menu-items/${b.item._id}`, "DELETE /api/v1/menu-items/:id"],
    ["get", `/api/v1/table/${b.table._id}`, "GET /api/v1/table/:id"],
    ["put", `/api/v1/table/${b.table._id}`, "PUT /api/v1/table/:id"],
    ["delete", `/api/v1/table/${b.table._id}`, "DELETE /api/v1/table/:id"],
    ["post", `/api/v1/table/${b.table._id}/qr`, "POST /api/v1/table/:id/qr"],
    ["get", `/api/v1/employee/${b.employee._id}`, "GET /api/v1/employee/:id"],
    ["put", `/api/v1/employee/${b.employee._id}`, "PUT /api/v1/employee/:id"],
    ["delete", `/api/v1/employee/${b.employee._id}`, "DELETE /api/v1/employee/:id"],
    ["get", `/api/v1/orders/${orderB.order._id}`, "GET /api/v1/orders/:id"],
    ["post", `/api/v1/sessions/${orderB.order.sessionId}/close`, "POST /api/v1/sessions/:id/close"],
  ];
  for (const [method, url, pattern] of missing) {
    const res = await asA(method, url).send({ inStock: false, capacity: 2, position: "kitchen" });
    cover(pattern.split(" ")[0], pattern.split(" ").slice(1).join(" "));
    assert.equal(res.status, 404, pattern);
  }
  const stillOpen = await TableSession.findOne({
    _id: orderB.order.sessionId,
    restaurantId: b.restaurant._id,
  });
  assert.equal(stillOpen.status, "open");

  for (const [method, url, pattern] of [
    ["post", "/api/v1/orders", "POST /api/v1/orders"],
    ["put", `/api/v1/orders/${orderB.order._id}`, "PUT /api/v1/orders/:id"],
    ["put", `/api/v1/orders/${orderB.order._id}/status`, "PUT /api/v1/orders/:id/status"],
    ["delete", `/api/v1/orders/${orderB.order._id}`, "DELETE /api/v1/orders/:id"],
  ]) {
    const res = await asA(method, url).send({
      restaurantId: String(b.restaurant._id),
      status: "served",
    });
    cover(pattern.split(" ")[0], pattern.split(" ").slice(1).join(" "));
    assert.equal(res.status, 405, pattern);
  }
  assert.equal(
    (await Order.findOne({ _id: orderB.order._id, restaurantId: b.restaurant._id })).status,
    "pending"
  );

  const who = await asA("get", "/api/v1/auth/user");
  cover("GET", "/api/v1/auth/user");
  assert.equal(who.status, 200);
  assert.equal(who.body.user.restaurantId, String(a.restaurant._id));

  const ticket = await asA("post", "/api/v1/ws-ticket").send({ restaurantId: String(b.restaurant._id) });
  cover("POST", "/api/v1/ws-ticket");
  assert.equal(ticket.status, 200);
  assert.equal(jwt.verify(ticket.body.ticket, process.env.JWT_SECRET).restaurantId, String(a.restaurant._id));

  const users = await asA("get", "/api/v1/users");
  cover("GET", "/api/v1/users");
  assert.equal(users.status, 200);
  assert.equal(JSON.stringify(users.body).includes(String(orderB.order._id)), false);
  assert.equal(users.body.users.some((user) => user.password), false);

  const readUser = await asA("get", `/api/v1/users/${userA._id}`);
  cover("GET", "/api/v1/users/:id");
  assert.equal(readUser.status, 200);
  assert.equal(readUser.body.password, undefined);
  assert.equal(readUser.body.restaurantId, undefined);

  const renamed = await asA("put", `/api/v1/users/${userA._id}`).send({
    username: `renamed${tag}`,
    restaurantId: String(b.restaurant._id),
  });
  cover("PUT", "/api/v1/users/:id");
  assert.equal(renamed.status, 200);
  assert.equal((await User.findById(userA._id)).restaurantId, undefined);

  const disposable = await User.create({
    username: `gone${tag}`,
    email: `gone-${tag}@example.com`,
    password: passwordHash,
  });
  const removed = await asA("delete", `/api/v1/users/${disposable._id}`);
  cover("DELETE", "/api/v1/users/:id");
  assert.equal(removed.status, 200);
  assert.ok(await Employee.findOne({ _id: b.employee._id, restaurantId: b.restaurant._id }));

  const board = await asA("get", "/api/v1/staff/board");
  cover("GET", "/api/v1/staff/board");
  assert.equal(board.status, 200);
  assert.equal(JSON.stringify(board.body).includes(String(orderB.order._id)), false);
  assert.equal(board.body.orders.every((order) => String(order.restaurantId) === String(a.restaurant._id)), true);

  const guestJwt = generateTableToken({
    restaurantId: a.restaurant._id,
    tableId: a.table._id,
    sessionId: orderA.order.sessionId,
  });
  const guestTicket = await request(app)
    .post("/api/v1/ws-ticket")
    .set("Authorization", `Bearer ${guestJwt}`);
  const staffSocket = await openSocket(`ticket=${encodeURIComponent(ticket.body.ticket)}`);
  const guestSocket = await openSocket(`ticket=${encodeURIComponent(guestTicket.body.ticket)}`);
  const staffB = await connect(b.token);
  const bOrderId = orderB.order._id;

  for (const [socket, type, payload] of [
    [staffSocket, "order.update", { orderId: bOrderId, items: itemsOf(a.item, 1) }],
    [staffSocket, "order.status", { orderId: bOrderId, status: "accepted" }],
    [staffSocket, "order.cancel", { orderId: bOrderId, reason: "no" }],
    [guestSocket, "order.update", { orderId: bOrderId, items: itemsOf(a.item, 1) }],
    [guestSocket, "order.status", { orderId: bOrderId, status: "accepted" }],
    [guestSocket, "order.cancel", { orderId: bOrderId, reason: "no" }],
    [staffSocket, "order.create", { clientOrderId: randomUUID(), tableId: String(b.table._id), items: itemsOf(a.item) }],
    [staffSocket, "order.create", { clientOrderId: randomUUID(), sessionId: String(orderB.order.sessionId), items: itemsOf(a.item) }],
  ]) {
    const ack = await ask(socket, type, payload);
    assert.equal(ack.ok, false, type);
    assert.equal(ack.error.code, "NOT_FOUND", type);
  }

  const staffMark = staffSocket.messages.length;
  const guestMark = guestSocket.messages.length;
  await changeStatus(staffCtx(b), { orderId: bOrderId, status: "accepted" });
  await waitFor(
    staffB.messages,
    (message) => message.event === "order.statusChanged" && message.data?.orderId === bOrderId
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const leaked = [
    ...staffSocket.messages.slice(staffMark),
    ...guestSocket.messages.slice(guestMark),
  ];
  assert.equal(leaked.some((message) => JSON.stringify(message).includes(bOrderId)), false);

  staffSocket.ws.close();
  guestSocket.ws.close();
  staffB.ws.close();

  assert.deepEqual([...exercised].sort(), [...AUTHENTICATED_ROUTES].sort());
});

test("authenticated routes are listed in the cross-tenant coverage table", () => {
  const live = collectAuthenticatedRoutes(app);
  const expected = [...AUTHENTICATED_ROUTES].sort();
  assert.deepEqual(live, expected);
});
