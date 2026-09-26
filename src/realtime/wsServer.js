import { WebSocketServer } from "ws";
import { parse as parseUrl } from "node:url";
import { verifyToken } from "../shared/auth.js";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { join, leaveAll, staffRoom, sessionRoom } from "./rooms.js";
import { handleMessage } from "./handlers.js";
import { assertOpenSession } from "../modules/ordering/session.service.js";

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const PROTOCOL_VERSION = "2";

const allowedOrigins = () =>
  (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

export const sweepDeadSockets = (clients) => {
  for (const connection of clients) {
    if (connection.isAlive === false) {
      leaveAll(connection);
      connection.terminate();
      continue;
    }
    connection.isAlive = false;
    try {
      connection.ping();
    } catch {
      connection.isAlive = false;
    }
  }
};

const authenticate = (query) => {
  const ticket = typeof query.ticket === "string" ? query.ticket : "";
  const legacy = typeof query.token === "string" ? query.token : "";
  if (!ticket && !legacy) {
    return { ok: false, code: 4003, reason: "forbidden" };
  }
  let auth;
  try {
    auth = verifyToken(ticket || legacy);
  } catch (error) {
    const expired = error?.name === "TokenExpiredError";
    return {
      ok: false,
      code: expired ? 4001 : 4003,
      reason: expired ? "token expired" : "forbidden",
    };
  }
  if (ticket && auth.purpose !== "ws") {
    return { ok: false, code: 4003, reason: "forbidden" };
  }
  if (auth.role !== "employee" && auth.role !== "guest") {
    return { ok: false, code: 4003, reason: "forbidden" };
  }
  if (!auth.restaurantId) {
    return { ok: false, code: 4003, reason: "forbidden" };
  }
  return { ok: true, auth };
};

export const attachWebSocket = (server) => {
  const wss = new WebSocketServer({
    noServer: true,
    path: "/ws",
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  const closeAfterUpgrade = (request, socket, head, code, reason) => {
    wss.handleUpgrade(request, socket, head, (connection) => {
      connection.on("error", () => {});
      connection.close(code, reason);
    });
  };

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

    const version = query.v == null || query.v === "" ? PROTOCOL_VERSION : String(query.v);
    if (version !== PROTOCOL_VERSION) {
      closeAfterUpgrade(request, socket, head, 4000, "unsupported protocol version");
      return;
    }

    const result = authenticate(query);
    if (!result.ok) {
      closeAfterUpgrade(request, socket, head, result.code, result.reason);
      return;
    }

    wss.handleUpgrade(request, socket, head, (connection) => {
      wss.emit("connection", connection, result.auth);
    });
  });

  wss.on("connection", async (connection, auth) => {
    connection.on("error", (error) => {
      logger.warn({ err: error }, "ws socket error");
    });
    try {
      if (auth.role === "guest") {
        await assertOpenSession(auth.restaurantId, auth.sessionId);
        join(sessionRoom(auth.restaurantId, auth.sessionId), connection);
      } else {
        join(staffRoom(auth.restaurantId), connection);
      }
    } catch (error) {
      const closed = error instanceof AppError && error.code === "SESSION_CLOSED";
      logger.error({ err: error, restaurantId: auth.restaurantId }, "ws connection rejected");
      connection.close(closed ? 4004 : 4003, closed ? "session closed" : "forbidden");
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
    sweepDeadSockets(wss.clients);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));
  return wss;
};
