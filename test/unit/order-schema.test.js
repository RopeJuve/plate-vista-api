import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createFiskalyClient, FiskalyError } from "../../src/modules/tse/fiskaly.client.js";
import { orderSchema } from "../../src/modules/ordering/order.signing.js";
import { createFakeFiskaly } from "../support/fakeFiskaly.js";

const BASE = "https://kassensichv-middleware.fiskaly.com/api/v2";

const signer = async () => {
  const fake = createFakeFiskaly({ apiKey: "key", apiSecret: "very-secret" });
  const client = createFiskalyClient({ apiKey: "key", apiSecret: "very-secret", baseUrl: BASE, fetch: fake.fetch });
  const tssId = randomUUID();
  const tss = await client.createTss(tssId);
  await client.setTssState(tssId, "UNINITIALIZED");
  await client.changeAdminPin(tssId, { adminPuk: tss.admin_puk, newAdminPin: "pin-123456" });
  await client.adminAuth(tssId, "pin-123456");
  await client.setTssState(tssId, "INITIALIZED");
  const clientId = randomUUID();
  await client.createClient(tssId, clientId, "PV-test");
  await client.adminLogout(tssId);
  return async (schema) => {
    const txId = randomUUID();
    await client.startTx(tssId, txId, { clientId });
    return client.finishTx(tssId, txId, { clientId, schema });
  };
};

// fiskaly rejected every Bestellung with E_PARSER because the quantity went
// out as a number (#58).
test("a Bestellung and a correction send every line item value as a string", async () => {
  const schema = orderSchema([
    { text: "Pizza", unitPriceCents: 1250, quantity: 2 },
    { text: "Beer", unitPriceCents: 450, quantity: -1 },
  ]);
  assert.deepEqual(schema.standard_v1.order.line_items, [
    { quantity: "2", text: "Pizza", price_per_unit: "12.50" },
    { quantity: "-1", text: "Beer", price_per_unit: "4.50" },
  ]);
  const sign = await signer();
  assert.equal((await sign(schema)).state, "FINISHED");
});

test("the fake fiskaly rejects a numeric quantity as the real one does", async () => {
  const sign = await signer();
  const schema = { standard_v1: { order: { line_items: [{ quantity: 1, text: "Pizza", price_per_unit: "12.50" }] } } };
  await assert.rejects(sign(schema), (error) => {
    assert.ok(error instanceof FiskalyError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "E_PARSER");
    assert.match(error.message, /line_items\.0\.quantity: Invalid type\. Expected: string, given: integer/);
    return true;
  });
});
