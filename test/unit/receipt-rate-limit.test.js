// The receipt limiter, exactly: 60 requests a minute per IP. Malformed tokens
// are rejected before any database read, so this needs no database.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import receiptRouter from "../../src/modules/payments/receipt.routes.js";
import { AppError } from "../../src/shared/errors.js";

const app = express();
app.set("trust proxy", 1);
app.use("/api/v1/receipts", receiptRouter);
app.use((err, _req, res, _next) => {
  if (err instanceof AppError) return res.status(err.status).json({ code: err.code });
  return res.status(500).json({ code: "INTERNAL" });
});

const fetchReceipt = (ip) =>
  request(app).get("/api/v1/receipts/not-a-token").set("X-Forwarded-For", ip);

test("the 61st receipt request in a minute from one IP is the first one limited", async () => {
  for (let i = 1; i <= 60; i += 1) {
    const res = await fetchReceipt("203.0.113.1");
    assert.equal(res.status, 404, `request ${i} is not limited`);
  }
  const limited = await fetchReceipt("203.0.113.1");
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
});

test("another IP keeps its own allowance", async () => {
  const res = await fetchReceipt("203.0.113.2");
  assert.equal(res.status, 404);
  assert.equal(res.headers["ratelimit-policy"], "60;w=60");
});
