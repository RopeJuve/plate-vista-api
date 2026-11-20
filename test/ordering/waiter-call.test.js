process.env.JWT_SECRET = "test-secret-waiter-call";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateTableToken, generateToken } from "../../src/shared/auth.js";
import { closeSession, openOrJoinSessionSafe } from "../../src/modules/ordering/session.service.js";
import Table from "../../src/modules/tables/table.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";

let replset;
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

// Lets in-flight events arrive before asserting that one did not.
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const connect = (token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const messages = [];
    ws.on("message", (buf) => messages.push(JSON.parse(buf.toString())));
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });

const ask = async (client, type, payload = {}) => {
  const requestId = randomUUID();
  client.ws.send(JSON.stringify({ type, requestId, payload }));
  return waitFor(client.messages, (message) => message.type === "ack" && message.requestId === requestId);
};

const eventsOf = (client, name) => client.messages.filter((message) => message.type === "event" && message.event === name);

// A restaurant with table 7 seated, a waiter, and a guest token for that table.
const fixture = async () => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({ name: `R${suffix}`, slug: `r-${suffix}` });
  const waiter = await Employee.create({
    restaurantId: restaurant._id,
    employee: `waiter-${suffix}`,
    email: `waiter-${suffix}@example.com`,
    password: "x".repeat(60),
    position: "waiter",
    role: "waiter",
  });
  const table = await Table.create({ restaurantId: restaurant._id, tableNumber: 7, capacity: 4 });
  const session = await openOrJoinSessionSafe(restaurant._id, table._id);
  return {
    restaurant,
    waiter,
    table,
    session,
    staffToken: generateToken(waiter),
    guestToken: generateTableToken({ restaurantId: restaurant._id, tableId: table._id, sessionId: session._id }),
  };
};

test.before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_DB_URL = replset.getUri();
  await connectToDatabase();
  const { default: app } = await import("../../src/app.js");
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

test("a guest calls the waiter: staff and the whole table hear which table called", async () => {
  const place = await fixture();
  const staff = await connect(place.staffToken);
  const guest = await connect(place.guestToken);
  const otherGuest = await connect(place.guestToken);

  const ack = await ask(guest, "waiter.call");

  assert.equal(ack.ok, true);
  const called = await waitFor(staff.messages, (message) => message.event === "waiter.called");
  assert.equal(called.data.sessionId, String(place.session._id));
  assert.equal(called.data.tableId, String(place.table._id));
  assert.equal(called.data.tableNumber, 7);
  assert.ok(Date.parse(called.data.calledAt));
  await waitFor(otherGuest.messages, (message) => message.event === "waiter.called");
  for (const client of [staff, guest, otherGuest]) client.ws.close();
});

test("calling again while a call is open sends no second alert", async () => {
  const place = await fixture();
  const staff = await connect(place.staffToken);
  const guest = await connect(place.guestToken);

  await ask(guest, "waiter.call");
  const again = await ask(guest, "waiter.call");
  await settle();

  assert.equal(again.ok, true);
  assert.equal(eventsOf(staff, "waiter.called").length, 1);
  staff.ws.close();
  guest.ws.close();
});

test("staff close a call; the table hears it and may call again", async () => {
  const place = await fixture();
  const staff = await connect(place.staffToken);
  const guest = await connect(place.guestToken);
  await ask(guest, "waiter.call");

  const ack = await ask(staff, "waiter.dismiss", { sessionId: String(place.session._id) });

  assert.equal(ack.ok, true);
  const dismissed = await waitFor(guest.messages, (message) => message.event === "waiter.dismissed");
  assert.equal(dismissed.data.sessionId, String(place.session._id));
  await waitFor(staff.messages, (message) => message.event === "waiter.dismissed");

  await ask(guest, "waiter.call");
  await settle();
  assert.equal(eventsOf(staff, "waiter.called").length, 2);
  staff.ws.close();
  guest.ws.close();
});

test("a second waiter closing the same call is fine and sends nothing more", async () => {
  const place = await fixture();
  const staff = await connect(place.staffToken);
  const guest = await connect(place.guestToken);
  await ask(guest, "waiter.call");
  await ask(staff, "waiter.dismiss", { sessionId: String(place.session._id) });

  const again = await ask(staff, "waiter.dismiss", { sessionId: String(place.session._id) });
  await settle();

  assert.equal(again.ok, true);
  assert.equal(eventsOf(guest, "waiter.dismissed").length, 1);
  staff.ws.close();
  guest.ws.close();
});

test("a guest cannot close a call and staff cannot place one", async () => {
  const place = await fixture();
  const staff = await connect(place.staffToken);
  const guest = await connect(place.guestToken);

  const guestDismiss = await ask(guest, "waiter.dismiss", { sessionId: String(place.session._id) });
  const staffCall = await ask(staff, "waiter.call");

  assert.equal(guestDismiss.ok, false);
  assert.equal(guestDismiss.error.code, "FORBIDDEN");
  assert.equal(staffCall.ok, false);
  assert.equal(staffCall.error.code, "FORBIDDEN");
  staff.ws.close();
  guest.ws.close();
});

test("staff and guests who connect later are told about a call that is still open", async () => {
  const place = await fixture();
  const guest = await connect(place.guestToken);
  await ask(guest, "waiter.call");

  const staff = await connect(place.staffToken);
  const reloadedGuest = await connect(place.guestToken);

  const replayed = await waitFor(staff.messages, (message) => message.event === "waiter.called");
  assert.equal(replayed.data.tableNumber, 7);
  await waitFor(reloadedGuest.messages, (message) => message.event === "waiter.called");
  guest.ws.close();
  staff.ws.close();
  reloadedGuest.ws.close();
});

test("a call from another restaurant never reaches this restaurant's staff", async () => {
  const mine = await fixture();
  const theirs = await fixture();
  const staff = await connect(mine.staffToken);
  const theirGuest = await connect(theirs.guestToken);

  await ask(theirGuest, "waiter.call");
  await settle();
  const lateStaff = await connect(mine.staffToken);
  await settle();

  assert.equal(eventsOf(staff, "waiter.called").length, 0);
  assert.equal(eventsOf(lateStaff, "waiter.called").length, 0);
  staff.ws.close();
  theirGuest.ws.close();
  lateStaff.ws.close();
});

test("closing the table ends its call", async () => {
  const place = await fixture();
  const guest = await connect(place.guestToken);
  await ask(guest, "waiter.call");

  await closeSession(
    { restaurantId: place.restaurant._id, requestId: randomUUID(), actor: { type: "employee", id: place.waiter._id, position: "waiter" } },
    place.session._id
  );
  const staff = await connect(place.staffToken);
  await settle();

  assert.equal(eventsOf(staff, "waiter.called").length, 0);
  guest.ws.close();
  staff.ws.close();
});
