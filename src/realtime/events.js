import { closeRoom, emit, emitRestaurant, sessionRoom, staffRoom } from "./rooms.js";
import { logger } from "../shared/logger.js";

export const published = [];

export const clearPublished = () => {
  published.length = 0;
};

export const deliverLocal = ({ restaurantId, sessionId, fanout, audience, message }) => {
  if (fanout) {
    emitRestaurant(String(restaurantId), message);
    return;
  }
  emit(staffRoom(restaurantId), message);
  if (sessionId && audience !== "staff") {
    emit(sessionRoom(restaurantId, sessionId), message);
  }
  if (message?.event === "session.closed" && sessionId) {
    closeRoom(sessionRoom(restaurantId, sessionId), 4004, "session closed");
  }
};

const notifyRender = (envelope) => {
  const base = process.env.RENDER_INTERNAL_URL;
  const secret = process.env.INTERNAL_SECRET;
  if (!base || !secret) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  const url = new URL("/internal/emit", base);
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": secret,
    },
    body: JSON.stringify(envelope),
    signal: controller.signal,
  })
    .catch((error) => {
      logger.warn({ err: error }, "internal emit failed");
    })
    .finally(() => clearTimeout(timer));
};

// Services call publish and stay unaware of which process owns the sockets.
// Vercel fires a short notify to Render; Render and local emit in-process.
export const publish = (envelope) => {
  if (process.env.NODE_ENV === "test") published.push(envelope);
  const target = process.env.DEPLOY_TARGET || "local";
  if (target === "vercel") {
    notifyRender(envelope);
    return;
  }
  deliverLocal(envelope);
};
