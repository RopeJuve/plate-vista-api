import { closeRoom, emit, emitRestaurant, sessionRoom, staffRoom } from "./rooms.js";
import { postToRender, runsOnVercel } from "../shared/renderChannel.js";

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

// Services call publish and stay unaware of which process owns the sockets.
// Vercel fires a short notify to Render; Render and local emit in-process.
export const publish = (envelope) => {
  if (process.env.NODE_ENV === "test") published.push(envelope);
  if (runsOnVercel()) {
    postToRender("/internal/emit", envelope);
    return;
  }
  deliverLocal(envelope);
};
