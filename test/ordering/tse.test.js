process.env.JWT_SECRET = "test-secret-tse";
process.env.NODE_ENV = "test";
process.env.DEPLOY_TARGET = "local";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";
import { generateToken, hashPassword } from "../../src/shared/auth.js";
import { decrypt } from "../../src/shared/crypto.js";
import { capturedLogs, clearCapturedLogs } from "../../src/shared/logger.js";
import Restaurant from "../../src/modules/restaurants/restaurant.model.js";
import Employee from "../../src/modules/staff/employee.model.js";
import { createFiskalyClient } from "../../src/modules/tse/fiskaly.client.js";
import { setFiskalyClient } from "../../src/modules/tse/tse.service.js";
import { createFakeFiskaly } from "../support/fakeFiskaly.js";

const API_SECRET = "fiskaly-api-secret-value";
let mongod;
let app;
let request;
let passwordHash;
let fake;

const LEGAL = {
  legalName: "Pizzeria Roma GmbH",
  address: { street: "Hauptstraße 1", zip: "10115", city: "Berlin", country: "DE" },
  taxNumber: "27/123/45678",
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

const place = async ({ legal = LEGAL } = {}) => {
  const suffix = randomUUID().slice(0, 8);
  const restaurant = await Restaurant.create({ name: `R${suffix}`, slug: `r-${suffix}`, legal });
  const owner = await staffOf(restaurant, "owner");
  const admin = await staffOf(restaurant, "admin");
  const as = (who) => (method, path) =>
    request(app)[method](`/api/v1/tse${path}`).set("Authorization", `Bearer ${generateToken(who)}`);
  return { restaurant, owner, admin, asOwner: as(owner), asAdmin: as(admin), as };
};

const secretsOf = async (restaurantId) => {
  const stored = await Restaurant.findById(restaurantId)
    .select("+tse.adminPinEnc +tse.adminPukEnc")
    .lean();
  return {
    tse: stored.tse,
    pin: stored.tse?.adminPinEnc ? decrypt(stored.tse.adminPinEnc) : null,
    puk: stored.tse?.adminPukEnc ? decrypt(stored.tse.adminPukEnc) : null,
  };
};

const SETUP_OPS = [
  "createTss",
  "setTssState",
  "changeAdminPin",
  "adminAuth",
  "setTssState",
  "createClient",
  "adminLogout",
];

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_DB_URL = mongod.getUri();
  await connectToDatabase();
  ({ default: request } = await import("supertest"));
  ({ default: app } = await import("../../src/app.js"));
  passwordHash = await hashPassword("supersecret1");
}, { timeout: 120000 });

test.beforeEach(() => {
  fake = createFakeFiskaly({ apiKey: "fiskaly-key", apiSecret: API_SECRET });
  setFiskalyClient(createFiskalyClient({ apiKey: "fiskaly-key", apiSecret: API_SECRET, fetch: fake.fetch }));
  clearCapturedLogs();
});

test.after(async () => {
  setFiskalyClient(null);
  await disconnectDatabase();
  await mongod?.stop();
});

test("an inactive TSE reports its status; incomplete legal details refuse setup without calling fiskaly", async () => {
  const { asOwner, asAdmin } = await place({ legal: { legalName: "Only a name" } });
  const status = await asAdmin("get", "");
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { active: false, failedSignatures: 0 });

  const refused = await asOwner("post", "/setup");
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "RESTAURANT_DETAILS_MISSING");
  assert.deepEqual(fake.calls, []);
});

test("setup activates the TSE in order and never returns or logs the PIN, PUK or API secret", async () => {
  const { restaurant, asOwner, asAdmin } = await place();
  const res = await asOwner("post", "/setup");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(fake.ops({ withAuth: false }), SETUP_OPS);
  const states = fake.calls.filter((call) => call.op === "setTssState").map((call) => call.body.state);
  assert.deepEqual(states, ["UNINITIALIZED", "INITIALIZED"]);
  const createClient = fake.calls.find((call) => call.op === "createClient");
  assert.equal(createClient.body.serial_number, `PV-${restaurant._id}`);

  const { tse, pin, puk } = await secretsOf(restaurant._id);
  const tss = fake.tss(tse.tssId);
  assert.equal(tss.state, "INITIALIZED");
  assert.equal(tss.admin_authenticated, false);
  assert.equal(pin, tss.admin_pin);
  assert.equal(puk, tss.admin_puk);
  assert.ok(pin.length >= 16, "admin PIN is long and random");
  assert.equal(tse.setupStep, "DONE");
  assert.equal(tse.tssSerial, tss.serial_number);
  assert.equal(tse.clientSerial, `PV-${restaurant._id}`);
  assert.ok(tss.clients.has(tse.clientId));

  assert.deepEqual(Object.keys(res.body).sort(), ["active", "clientId", "failedSignatures", "setupAt", "tssSerial"]);
  assert.equal(res.body.active, true);
  assert.equal(res.body.tssSerial, tss.serial_number);
  assert.equal(res.body.clientId, tse.clientId);
  assert.equal(res.body.failedSignatures, 0);
  assert.ok(!Number.isNaN(Date.parse(res.body.setupAt)));

  const status = await asAdmin("get", "");
  assert.deepEqual(status.body, res.body);

  const plain = (await Restaurant.findById(restaurant._id).lean()).tse;
  assert.equal("adminPinEnc" in plain, false);
  assert.equal("adminPukEnc" in plain, false);

  for (const text of [res.text, status.text, JSON.stringify(capturedLogs)]) {
    for (const secret of [pin, puk, API_SECRET, tse.adminPinEnc, tse.adminPukEnc]) {
      assert.equal(text.includes(secret), false);
    }
  }

  fake.clearCalls();
  const again = await asOwner("post", "/setup");
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, res.body);
  assert.deepEqual(fake.calls, []);
});

test("a setup that fails at admin auth answers 502 and the next call resumes there", async () => {
  const { restaurant, asOwner, asAdmin } = await place();
  fake.failNext("adminAuth", { status: 500, code: "E_INTERNAL", message: "fiskaly down" });
  const failed = await asOwner("post", "/setup");
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, "TSE_SETUP_FAILED");
  assert.deepEqual(fake.ops({ withAuth: false }), SETUP_OPS.slice(0, 4));
  assert.deepEqual((await asAdmin("get", "")).body, { active: false, failedSignatures: 0 });
  const before = await secretsOf(restaurant._id);
  assert.equal(before.tse.setupStep, "PIN_SET");

  fake.clearCalls();
  const resumed = await asOwner("post", "/setup");
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.deepEqual(fake.ops({ withAuth: false }), SETUP_OPS.slice(3));
  const after = await secretsOf(restaurant._id);
  assert.equal(after.tse.tssId, before.tse.tssId);
  assert.equal(after.pin, before.pin);
  assert.equal(after.tse.setupStep, "DONE");
  assert.equal(resumed.body.active, true);
});

test("a setup that fails at client creation resumes with a fresh admin login", async () => {
  const { restaurant, asOwner } = await place();
  fake.failNext("createClient", { status: 503 });
  assert.equal((await asOwner("post", "/setup")).status, 502);
  assert.equal((await secretsOf(restaurant._id)).tse.setupStep, "INITIALIZED");

  fake.clearCalls();
  const resumed = await asOwner("post", "/setup");
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.deepEqual(fake.ops({ withAuth: false }), ["adminAuth", "createClient", "adminLogout"]);
});

test("only the owner and admins of the token's restaurant see or set up the TSE", async () => {
  const mine = await place();
  for (const position of ["waiter", "kitchen", "staff"]) {
    const asStaff = mine.as(await staffOf(mine.restaurant, position));
    assert.equal((await asStaff("get", "")).status, 403, position);
    assert.equal((await asStaff("post", "/setup")).status, 403, position);
  }
  assert.deepEqual(fake.calls, []);
  assert.equal((await request(app).post("/api/v1/tse/setup")).status, 401);

  const other = await place();
  assert.equal((await other.asAdmin("post", "/setup")).status, 200);
  assert.deepEqual((await mine.asOwner("get", "")).body, { active: false, failedSignatures: 0 });
  assert.equal((await Restaurant.findById(mine.restaurant._id).lean()).tse?.tssId ?? null, null);
});

test("without an encryption key setup refuses before calling fiskaly", async () => {
  const { asOwner } = await place();
  const key = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  try {
    const res = await asOwner("post", "/setup");
    assert.equal(res.status, 500);
    assert.deepEqual(fake.calls, []);
  } finally {
    process.env.ENCRYPTION_KEY = key;
  }
});
