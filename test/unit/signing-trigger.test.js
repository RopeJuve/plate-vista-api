process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import { requestSigning } from "../../src/modules/payments/signing.js";
import { capturedLogs, clearCapturedLogs } from "../../src/shared/logger.js";

const PAYMENT_ID = "507f1f77bcf86cd799439011";
const SECRET = "internal-secret-0123456789";

const withEnv = async (env, run) => {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const vercel = { DEPLOY_TARGET: "vercel", RENDER_INTERNAL_URL: "https://render.example.com", INTERNAL_SECRET: SECRET };

test("on Vercel a payment is sent to Render's /internal/sign with the secret", async () => {
  await withEnv(vercel, async () => {
    const sent = [];
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), init });
      return new Response(null, { status: 202 });
    };
    await requestSigning({ kind: "PAYMENT", id: PAYMENT_ID });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://render.example.com/internal/sign");
    assert.equal(sent[0].init.method, "POST");
    assert.equal(sent[0].init.headers["x-internal-secret"], SECRET);
    assert.deepEqual(JSON.parse(sent[0].init.body), { kind: "PAYMENT", id: PAYMENT_ID });
    assert.ok(sent[0].init.signal, "the call can time out");
  });
});

test("on Vercel a failed ping only logs, without the secret", async () => {
  await withEnv(vercel, async () => {
    clearCapturedLogs();
    let failed;
    const done = new Promise((resolve) => {
      failed = resolve;
    });
    globalThis.fetch = async () => {
      setImmediate(failed);
      throw new Error("connect ECONNREFUSED");
    };
    await requestSigning({ kind: "PAYMENT", id: PAYMENT_ID });
    await done;
    await new Promise((resolve) => setImmediate(resolve));
    const logged = JSON.stringify(capturedLogs);
    assert.match(logged, /507f1f77bcf86cd799439011/);
    assert.equal(logged.includes(SECRET), false);
  });
});

test("on Vercel the ping gives up after 1.5 s", async () => {
  await withEnv(vercel, async () => {
    let aborted;
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const started = Date.now();
    await requestSigning({ kind: "PAYMENT", id: PAYMENT_ID });
    assert.ok(Date.now() - started < 500, "the request does not wait for Render");
    while (!aborted && Date.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(aborted);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1400 && elapsed < 2500, `aborted after ${elapsed} ms`);
  });
});
