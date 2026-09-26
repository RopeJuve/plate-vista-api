import { WebSocketServer } from "ws";
import { parse as parseUrl } from "node:url";
import { verifyToken } from "../shared/auth.js";
import { logger } from "../shared/logger.js";
import { join, leaveAll, staffRoom, sessionRoom } from "./rooms.js";
import { handleMessage } from "./handlers.js";
import { assertOpenSession } from "../modules/ordering/session.service.js";

const allowedOrigins = () =>
  (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

export const attachWebSocket = (server) => {
  const wss = new WebSocketServer({
    noServer: true,
    path: "/ws",
    maxPayload: 16 * 1024,
  });

  server.on("upgrade", (request, socket, head) => {
    const { pathname, query } = parseUrl(request.url, true);
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const origin = request.headers.origin;
    const allowed = allowedOrigins();
    if (allowed.length && origin && !allowed.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const token = query.token;
    if (!token || typeof token !== "string") {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    let auth;
    try {
      auth = verifyToken(token);
    } catch (error) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (auth.role !== "employee" && auth.role !== "guest") {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!auth.restaurantId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (connection) => {
      wss.emit("connection", connection, auth);
    });
  });

  wss.on("connection", async (connection, auth) => {
    try {
      if (auth.role === "guest") {
        await assertOpenSession(auth.restaurantId, auth.sessionId);
        join(sessionRoom(auth.restaurantId, auth.sessionId), connection);
      } else {
        join(staffRoom(auth.restaurantId), connection);
      }
    } catch (error) {
      logger.error({ err: error, restaurantId: auth.restaurantId }, "ws connection rejected");
      connection.close(4003, "session closed");
      return;
    }

    connection.isAlive = true;
    connection.on("pong", () => {
      connection.isAlive = true;
    });
    connection.on("message", (message) => {
      handleMessage(message, connection, auth);
    });
    connection.on("close", () => {
      leaveAll(connection);
    });
  });

  const heartbeat = setInterval(() => {
    for (const connection of wss.clients) {
      if (connection.isAlive === false) {
        leaveAll(connection);
        connection.terminate();
        continue;
      }
      connection.isAlive = false;
      connection.ping();
    }
  }, 30000);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));
  return wss;
};
