import test from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../../src/config/env.js";

const base = {
  JWT_SECRET: "test-secret",
  MONGO_DB_URL: "mongodb://127.0.0.1:27017/plate",
};

test("local deployment starts without render settings", () => {
  const env = loadEnv(base);
  assert.equal(env.DEPLOY_TARGET, "local");
  assert.equal(env.port, 8080);
});

test("vercel requires the render notify URL and shared secret", () => {
  assert.throws(
    () => loadEnv({ ...base, DEPLOY_TARGET: "vercel" }),
    /RENDER_INTERNAL_URL|INTERNAL_SECRET/
  );
});

test("render requires the internal secret", () => {
  assert.throws(
    () => loadEnv({ ...base, DEPLOY_TARGET: "render" }),
    /INTERNAL_SECRET/
  );
  const env = loadEnv({
    ...base,
    DEPLOY_TARGET: "render",
    INTERNAL_SECRET: "0123456789abcdef",
    CORS_ORIGIN: "https://app.example.com",
  });
  assert.equal(env.DEPLOY_TARGET, "render");
});

test("a deployed target refuses to start without CORS_ORIGIN", () => {
  for (const DEPLOY_TARGET of ["render", "vercel"]) {
    assert.throws(
      () =>
        loadEnv({
          ...base,
          DEPLOY_TARGET,
          INTERNAL_SECRET: "0123456789abcdef",
          RENDER_INTERNAL_URL: "https://render.example.com",
        }),
      /CORS_ORIGIN is required/
    );
  }
  assert.deepEqual(loadEnv(base).corsOrigins, []);
});

test("legacy ws tokens stay allowed until switched off", () => {
  assert.equal(loadEnv(base).ALLOW_LEGACY_WS_TOKEN, "true");
  assert.equal(loadEnv({ ...base, ALLOW_LEGACY_WS_TOKEN: "false" }).ALLOW_LEGACY_WS_TOKEN, "false");
  assert.throws(() => loadEnv({ ...base, ALLOW_LEGACY_WS_TOKEN: "yes" }));
});

const key32 = Buffer.alloc(32, 7).toString("base64");
const production = {
  ...base,
  NODE_ENV: "production",
  FISKALY_API_KEY: "key",
  FISKALY_API_SECRET: "secret",
  ENCRYPTION_KEY: key32,
};

test("fiskaly and encryption settings are optional outside production", () => {
  const env = loadEnv(base);
  assert.equal(env.FISKALY_API_KEY, undefined);
  assert.equal(env.FISKALY_BASE_URL, "https://kassensichv-middleware.fiskaly.com/api/v2");
  assert.equal(env.ENABLE_JOBS, "false");
  assert.equal(loadEnv({ ...base, ENABLE_JOBS: "true" }).ENABLE_JOBS, "true");
  assert.throws(() => loadEnv({ ...base, ENABLE_JOBS: "yes" }), /ENABLE_JOBS/);
});

test("production requires the fiskaly credentials and an encryption key", () => {
  assert.equal(loadEnv(production).FISKALY_API_KEY, "key");
  for (const name of ["FISKALY_API_KEY", "FISKALY_API_SECRET", "ENCRYPTION_KEY"]) {
    assert.throws(() => loadEnv({ ...production, [name]: "" }), new RegExp(name));
  }
});

test("an ENCRYPTION_KEY that is not 32 bytes of base64 is rejected", () => {
  assert.equal(loadEnv({ ...base, ENCRYPTION_KEY: key32 }).ENCRYPTION_KEY, key32);
  for (const bad of [Buffer.alloc(16).toString("base64"), Buffer.alloc(33).toString("base64"), "not base64!"]) {
    assert.throws(() => loadEnv({ ...base, ENCRYPTION_KEY: bad }), /ENCRYPTION_KEY/);
    assert.throws(() => loadEnv({ ...production, ENCRYPTION_KEY: bad }), /ENCRYPTION_KEY/);
  }
});
