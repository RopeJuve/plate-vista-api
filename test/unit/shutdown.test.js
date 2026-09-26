process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { WebSocket } from "ws";
import app from "../../src/app.js";
import { attachWebSocket } from "../../src/realtime/wsServer.js";
import { shutdownResources } from "../../src/server.js";

test("graceful shutdown closes sockets", async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const sockets = attachWebSocket(server);
  const token = jwt.sign(
    {
      id: new mongoose.Types.ObjectId().toString(),
      role: "employee",
      position: "admin",
      restaurantId: new mongoose.Types.ObjectId().toString(),
    },
    process.env.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "1h" }
  );
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  await shutdownResources({
    server,
    sockets,
    disconnect: async () => {},
    signal: "test",
  });
  const code = await closed;
  assert.equal(code, 1001);
});
