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
  });
  assert.equal(env.DEPLOY_TARGET, "render");
});
