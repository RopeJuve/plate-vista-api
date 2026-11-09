import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createFiskalyClient, FiskalyError } from "../../src/modules/tse/fiskaly.client.js";
import { createFakeFiskaly } from "../support/fakeFiskaly.js";

const BASE = "https://kassensichv-middleware.fiskaly.com/api/v2";

const setup = ({ tokenTtlSeconds = 300 } = {}) => {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const fake = createFakeFiskaly({ now, tokenTtlSeconds, apiKey: "key", apiSecret: "very-secret" });
  const client = createFiskalyClient({ apiKey: "key", apiSecret: "very-secret", baseUrl: BASE, fetch: fake.fetch, now });
  return { fake, client, advance: (ms) => (clock += ms) };
};

// Runs the setup steps against the fake and returns what a signing call needs.
const activate = async (client) => {
  const tssId = randomUUID();
  const tss = await client.createTss(tssId);
  await client.setTssState(tssId, "UNINITIALIZED");
  await client.changeAdminPin(tssId, { adminPuk: tss.admin_puk, newAdminPin: "pin-123456" });
  await client.adminAuth(tssId, "pin-123456");
  await client.setTssState(tssId, "INITIALIZED");
  const clientId = randomUUID();
  await client.createClient(tssId, clientId, "PV-test");
  await client.adminLogout(tssId);
  return { tssId, clientId, tss };
};

test("the token is fetched once and reused across calls", async () => {
  const { fake, client } = setup();
  const tssId = randomUUID();
  await client.createTss(tssId);
  await client.setTssState(tssId, "UNINITIALIZED");
  assert.deepEqual(fake.ops(), ["auth", "createTss", "setTssState"]);
  assert.deepEqual(fake.calls[0].body, { api_key: "key", api_secret: "very-secret" });
});

test("the token is refreshed 60 s before it expires", async () => {
  const { fake, client, advance } = setup({ tokenTtlSeconds: 300 });
  const tssId = randomUUID();
  await client.createTss(tssId);
  advance(239_000);
  await client.setTssState(tssId, "UNINITIALIZED");
  assert.equal(fake.ops().filter((op) => op === "auth").length, 1);
  advance(2_000);
  await client.setTssState(tssId, "UNINITIALIZED");
  assert.deepEqual(fake.ops(), ["auth", "createTss", "setTssState", "auth", "setTssState"]);
});

test("a 401 refreshes the token once and retries", async () => {
  const { fake, client } = setup();
  const tssId = randomUUID();
  await client.createTss(tssId);
  fake.expireTokens();
  await client.setTssState(tssId, "UNINITIALIZED");
  assert.deepEqual(fake.ops(), ["auth", "createTss", "setTssState", "auth", "setTssState"]);
  assert.equal(fake.tss(tssId).state, "UNINITIALIZED");

  fake.clearCalls();
  fake.failNext("adminAuth", { status: 401, code: "E_UNAUTHORIZED" });
  fake.failNext("adminAuth", { status: 401, code: "E_UNAUTHORIZED" });
  const error = await client.adminAuth(tssId, "whatever").catch((caught) => caught);
  assert.ok(error instanceof FiskalyError);
  assert.equal(error.status, 401);
  assert.deepEqual(fake.ops(), ["adminAuth", "auth", "adminAuth"]);
});

test("a 500 becomes a FiskalyError with status, code, message and request id", async () => {
  const { fake, client } = setup();
  fake.failNext("createTss", { status: 500, code: "E_INTERNAL", message: "boom" });
  const error = await client.createTss(randomUUID()).catch((caught) => caught);
  assert.ok(error instanceof FiskalyError);
  assert.equal(error.name, "FiskalyError");
  assert.equal(error.status, 500);
  assert.equal(error.code, "E_INTERNAL");
  assert.equal(error.message, "boom");
  assert.ok(error.requestId);
  assert.equal(JSON.stringify(error).includes("very-secret"), false);
  assert.equal(String(error.stack).includes("very-secret"), false);
});

test("a failed login and a network error are FiskalyErrors too", async () => {
  const { fake, client } = setup();
  fake.failNext("auth", { status: 401, code: "E_UNAUTHORIZED", message: "bad credentials" });
  const login = await client.createTss(randomUUID()).catch((caught) => caught);
  assert.ok(login instanceof FiskalyError);
  assert.equal(login.status, 401);
  assert.deepEqual(fake.ops(), ["auth"]);

  fake.failNext("createTss", { throws: new TypeError("fetch failed") });
  const network = await client.createTss(randomUUID()).catch((caught) => caught);
  assert.ok(network instanceof FiskalyError);
  assert.equal(network.status, 0);
  assert.equal(network.code, "NETWORK_ERROR");
});

test("the setup calls take a TSS from CREATED to INITIALIZED with a client", async () => {
  const { fake, client } = setup();
  const { tssId, clientId, tss } = await activate(client);
  assert.equal(tss.state, "CREATED");
  assert.ok(tss.serial_number);
  assert.equal(fake.tss(tssId).state, "INITIALIZED");
  assert.equal(fake.tss(tssId).clients.get(clientId).serial_number, "PV-test");
  assert.equal(fake.tss(tssId).admin_authenticated, false);
  const sent = fake.calls.map(({ op, method, path }) => `${op} ${method} ${path}`);
  assert.deepEqual(sent, [
    "auth POST /auth",
    `createTss PUT /tss/${tssId}`,
    `setTssState PATCH /tss/${tssId}`,
    `changeAdminPin PATCH /tss/${tssId}/admin`,
    `adminAuth POST /tss/${tssId}/admin/auth`,
    `setTssState PATCH /tss/${tssId}`,
    `createClient PUT /tss/${tssId}/client/${clientId}`,
    `adminLogout POST /tss/${tssId}/admin/logout`,
  ]);
});

test("transactions start, finish with a signature, and cancel", async () => {
  const { fake, client } = setup();
  const { tssId, clientId } = await activate(client);
  const schema = { standard_v1: { order: { line_items: [] } } };

  const txId = randomUUID();
  const started = await client.startTx(tssId, txId, { clientId });
  assert.equal(started.state, "ACTIVE");
  assert.match(fake.calls.at(-1).path, /tx_revision=1$/);
  const finished = await client.finishTx(tssId, txId, { clientId, schema });
  assert.equal(finished.state, "FINISHED");
  assert.match(fake.calls.at(-1).path, /tx_revision=2$/);
  assert.deepEqual(fake.calls.at(-1).body, { state: "FINISHED", client_id: clientId, schema });
  assert.equal(finished.signature.counter, fake.signatureCounter);
  assert.ok(finished.qr_code_data);

  const cancelledId = randomUUID();
  await client.startTx(tssId, cancelledId, { clientId });
  const cancelled = await client.cancelTx(tssId, cancelledId, { clientId, schema });
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(cancelled.number, finished.number + 1);

  const twice = await client.finishTx(tssId, txId, { clientId, schema, revision: 3 }).catch((caught) => caught);
  assert.ok(twice instanceof FiskalyError);
  assert.equal(twice.status, 409);
});

test("getTss and getClient read fiskaly's state and return null on 404", async () => {
  const { fake, client } = setup();
  const { tssId, clientId } = await activate(client);
  fake.clearCalls();

  const tss = await client.getTss(tssId);
  assert.equal(tss._id, tssId);
  assert.equal(tss.state, "INITIALIZED");
  assert.equal("admin_puk" in tss, false);
  const registered = await client.getClient(tssId, clientId);
  assert.equal(registered._id, clientId);
  assert.equal(registered.serial_number, "PV-test");
  assert.deepEqual(
    fake.calls.map(({ op, method, path }) => `${op} ${method} ${path}`),
    [`getTss GET /tss/${tssId}`, `getClient GET /tss/${tssId}/client/${clientId}`]
  );

  assert.equal(await client.getTss(randomUUID()), null);
  assert.equal(await client.getClient(tssId, randomUUID()), null);
  assert.equal(await client.getClient(randomUUID(), clientId), null);
});

test("getTss and getClient throw FiskalyError on errors other than 404", async () => {
  const { fake, client } = setup();
  const { tssId, clientId } = await activate(client);

  fake.failNext("getTss", { status: 500, code: "E_INTERNAL" });
  const tssError = await client.getTss(tssId).catch((caught) => caught);
  assert.ok(tssError instanceof FiskalyError);
  assert.equal(tssError.status, 500);

  fake.failNext("getClient", { status: 503, code: "E_UNAVAILABLE" });
  const clientError = await client.getClient(tssId, clientId).catch((caught) => caught);
  assert.ok(clientError instanceof FiskalyError);
  assert.equal(clientError.status, 503);

  fake.failNext("getTss", { throws: new TypeError("socket hang up") });
  const network = await client.getTss(tssId).catch((caught) => caught);
  assert.ok(network instanceof FiskalyError);
  assert.equal(network.code, "NETWORK_ERROR");

  fake.clearCalls();
  fake.expireTokens();
  assert.equal((await client.getTss(tssId)).state, "INITIALIZED");
  assert.deepEqual(fake.ops(), ["getTss", "auth", "getTss"]);
});

test("getTx reads a transaction's state and revision and returns null on 404", async () => {
  const { fake, client } = setup();
  const { tssId, clientId } = await activate(client);
  const txId = randomUUID();
  await client.startTx(tssId, txId, { clientId });
  fake.clearCalls();

  const active = await client.getTx(tssId, txId);
  assert.equal(active._id, txId);
  assert.equal(active.state, "ACTIVE");
  assert.equal(active.revision, 1);
  assert.deepEqual(
    fake.calls.map(({ op, method, path }) => `${op} ${method} ${path}`),
    [`getTx GET /tss/${tssId}/tx/${txId}`]
  );

  await client.finishTx(tssId, txId, { clientId });
  const finished = await client.getTx(tssId, txId);
  assert.equal(finished.state, "FINISHED");
  assert.equal(finished.revision, 2);
  assert.ok(finished.signature.value);

  assert.equal(await client.getTx(tssId, randomUUID()), null);
  fake.failNext("getTx", { status: 500 });
  const error = await client.getTx(tssId, txId).catch((caught) => caught);
  assert.ok(error instanceof FiskalyError);
  assert.equal(error.status, 500);
});
