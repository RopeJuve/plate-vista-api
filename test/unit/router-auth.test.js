// Walks every router's route table and asserts that any route NOT on the
// explicit public allow-list rejects an unauthenticated request with 401.
// This never touches the database: checkId-style pre-checks only validate
// ObjectId *format*, and every protected route puts requireAuth before any
// DB-touching middleware, so an unauthenticated request short-circuits
// before Mongoose is ever asked to do anything. Public routes are skipped
// entirely (some of them do hit the DB, e.g. GET /menu-items/:id).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

import {
  authRouter,
  userRouter,
  menuItemRouter,
  orderRouter,
  employeeRouter,
  tableRouter,
  statisticsRouter,
} from "../../routes/index.js";

const PLACEHOLDER_ID = "507f1f77bcf86cd799439011";

// method + raw path (as declared on the router) that are intentionally
// public. Everything else discovered on these routers must 401 without a
// token.
const PUBLIC_ROUTES = new Set([
  "auth POST /login",
  "auth POST /employee/login",
  "auth POST /table/:tableNumber",
  "users POST /",
  "menu-items GET /",
  "menu-items GET /category",
  "menu-items GET /:id",
]);

const ROUTERS = {
  auth: authRouter,
  users: userRouter,
  "menu-items": menuItemRouter,
  orders: orderRouter,
  employee: employeeRouter,
  table: tableRouter,
  statistics: statisticsRouter,
};

const listRoutes = (router) => {
  const routes = [];
  router.stack.forEach((layer) => {
    if (!layer.route) return;
    const path = layer.route.path;
    Object.keys(layer.route.methods).forEach((method) => {
      routes.push({ method: method.toUpperCase(), path });
    });
  });
  return routes;
};

const resolvePath = (path) =>
  path.replace(/:[^/]+/g, PLACEHOLDER_ID);

for (const [name, router] of Object.entries(ROUTERS)) {
  const app = express();
  app.use(express.json());
  app.use("/", router);

  for (const { method, path } of listRoutes(router)) {
    const key = `${name} ${method} ${path}`;
    if (PUBLIC_ROUTES.has(key)) continue;

    test(`${key} requires authentication`, async () => {
      const res = await request(app)[method.toLowerCase()](
        resolvePath(path)
      );
      assert.equal(
        res.status,
        401,
        `expected 401 without a token, got ${res.status}: ${JSON.stringify(res.body)}`
      );
    });
  }
}

test("every declared public route is still a real route on its router", () => {
  for (const key of PUBLIC_ROUTES) {
    const [name, method, ...pathParts] = key.split(" ");
    const path = pathParts.join(" ");
    const routes = listRoutes(ROUTERS[name]);
    const found = routes.some(
      (r) => r.method === method && r.path === path
    );
    assert.ok(found, `${key} is not a real route (stale allow-list entry?)`);
  }
});
