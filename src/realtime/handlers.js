import { WebSocket } from "ws";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { inboundMessageSchema } from "../modules/ordering/order.schemas.js";
import { executeOrderCommand } from "../modules/ordering/order.service.js";
import { assertOpenSession } from "../modules/ordering/session.service.js";

const WINDOW_MS = 10_000;
const MAX_MESSAGES = 10;
const EMPLOYEE_ONLY = new Set(["order.cancel", "order.status"]);

const allowMessage = (socket) => {
  const now = Date.now();
  const recent = (socket.msgTimes || []).filter((stamp) => now - stamp < WINDOW_MS);
  if (recent.length >= MAX_MESSAGES) {
    socket.msgTimes = recent;
    return false;
  }
  recent.push(now);
  socket.msgTimes = recent;
  return true;
};

const send = (connection, body) => {
  if (connection.readyState !== WebSocket.OPEN) return;
  connection.send(JSON.stringify(body));
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

    if (auth.exp && auth.exp * 1000 <= Date.now()) {
      connection.close(4001, "token expired");
      return;
    }
    if (!allowMessage(connection)) {
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
        error: { code: "VALIDATION", message: "Too many messages" },
      });
      return;
    }

    const parsed = inboundMessageSchema.safeParse(raw);
    if (!parsed.success) {
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
        error: { code: "VALIDATION", message: parsed.error.issues[0]?.message || "Invalid request" },
      });
      return;
    }

    if (auth.role === "guest") {
      await assertOpenSession(auth.restaurantId, auth.sessionId);
    }
    if (auth.role !== "employee" && EMPLOYEE_ONLY.has(parsed.data.type)) {
      throw new AppError("FORBIDDEN", "Forbidden");
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
    const code = error instanceof AppError ? error.code : "INTERNAL";
    const message = error instanceof AppError ? error.message : "Internal error";
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
    ack({ ok: false, error: { code, message } });
  }
};
