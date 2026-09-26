import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
};

test("order model is only imported from the ordering module", async () => {
  const files = await walk(path.join(root, "src"));
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    if (rel.startsWith(`src${path.sep}modules${path.sep}ordering${path.sep}`)) continue;
    if (rel === path.join("src", "db", "migrateTenants.js")) continue;
    const text = await readFile(file, "utf8");
    if (text.includes("order.model.js") || text.includes("models/orders.model")) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
});

test("app code does not branch on VERCEL and realtime does not dump every table", async () => {
  const files = [...(await walk(path.join(root, "src"))), path.join(root, "index.js")];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.equal(text.includes("process.env.VERCEL"), false, file);
    if (file.includes(`${path.sep}realtime${path.sep}`)) {
      assert.equal(text.includes("Table.find"), false, file);
    }
  }
  const appSource = await readFile(path.join(root, "src", "app.js"), "utf8");
  assert.equal(appSource.includes("attachWebSocket"), false);
  const serverSource = await readFile(path.join(root, "src", "server.js"), "utf8");
  assert.equal(serverSource.includes("attachWebSocket"), true);
});
