import { WebSocket } from "ws";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { zodFieldErrors } from "../shared/validate.js";
import { inboundMessageSchema } from "../modules/ordering/order.schemas.js";
import { executeOrderCommand } from "../modules/ordering/order.service.js";
import { assertOpenSession } from "../modules/ordering/session.service.js";

const WINDOW_MS = 10_000;
const MAX_MESSAGES = 10;
const MAX_VIOLATIONS = 3;

const allowMessage = (socket) => {
  const now = Date.now();
  const recent = (socket.msgTimes || []).filter((stamp) => now - stamp < WINDOW_MS);
  if (recent.length >= MAX_MESSAGES) {
    socket.msgTimes = recent;
    const retryAfterMs = Math.max(1, WINDOW_MS - (now - recent[0]));
    return { ok: false, retryAfterMs };
  }
  recent.push(now);
  socket.msgTimes = recent;
  return { ok: true };
};

const send = (connection, body) => {
  if (connection.readyState !== WebSocket.OPEN) return;
  connection.send(JSON.stringify(body));
};

const errorBody = (error) => {
  const code = error instanceof AppError ? error.code : "INTERNAL";
  const message = error instanceof AppError ? error.message : "Internal error";
  const body = { code, message };
  if (error instanceof AppError && error.details) body.details = error.details;
  return body;
};

export const handleMessage = async (bytes, connection, auth) => {
  let requestId = null;
  let acked = false;
  const ack = (body) => {
    if (acked) return;
    acked = true;
    send(connection, { type: "ack", requestId, ...body });
  };

  try {
    const raw = JSON.parse(bytes.toString());
    requestId = typeof raw?.requestId === "string" ? raw.requestId : null;

    // A ws ticket only authorises the handshake; its 60s expiry must not end
    // the connection. Legacy ?token= connections still expire with the token.
    if (auth.purpose !== "ws" && auth.exp && auth.exp * 1000 <= Date.now()) {
      connection.close(4001, "token expired");
      return;
    }
    const allowance = allowMessage(connection);
    if (!allowance.ok) {
      connection.violations = (connection.violations || 0) + 1;
      logger.error(
        {
          restaurantId: auth.restaurantId,
          sessionId: auth.sessionId || null,
          requestId,
        },
        "order failed"
      );
      ack({
        ok: false,
        error: {
          code: "RATE_LIMITED",
          message: "Too many messages",
          details: { retryAfterMs: allowance.retryAfterMs },
        },
      });
      if (connection.violations >= MAX_VIOLATIONS) {
        connection.close(4008, "too many violations");
      }
      return;
    }

    const parsed = inboundMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const fields = zodFieldErrors(parsed.error);
      logger.error(
        {
          restaurantId: auth.restaurantId,
          sessionId: auth.sessionId || null,
          requestId,
          err: parsed.error.issues[0]?.message,
        },
        "order failed"
      );
      ack({
        ok: false,
        error: {
          code: "VALIDATION",
          message: Object.values(fields)[0] || "Invalid request",
          details: { fields },
        },
      });
      return;
    }

    if (auth.role === "guest") {
      await assertOpenSession(auth.restaurantId, auth.sessionId);
    }

    const ctx = {
      restaurantId: auth.restaurantId,
      requestId,
      actor:
        auth.role === "employee"
          ? { type: "employee", id: auth.id }
          : {
              type: "guest",
              id: auth.userId || null,
              sessionId: auth.sessionId,
              tableId: auth.tableId,
            },
    };
    const result = await executeOrderCommand(ctx, parsed.data);
    ack({ ok: true, data: { order: result.order } });
  } catch (error) {
    if (error instanceof SyntaxError) {
      ack({
        ok: false,
        error: { code: "VALIDATION", message: "Invalid JSON" },
      });
      return;
    }
    if (!(error instanceof AppError)) {
      logger.error(
        {
          restaurantId: auth.restaurantId,
          sessionId: auth.sessionId || null,
          requestId,
          err: error,
        },
        "order failed"
      );
    }
    ack({ ok: false, error: errorBody(error) });
  }
};
