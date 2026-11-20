import { z } from "zod";
import { AppError } from "../shared/errors.js";
import { findCallingTable } from "../modules/ordering/session.service.js";
import { publish } from "./events.js";

// Open waiter calls live only in this process, the one that owns the sockets:
// nothing is stored, so a server restart forgets them. A staff screen or guest
// that connects later is told about the calls still open (see replayWaiterCalls).
const calls = new Map();

const keyOf = (restaurantId, sessionId) => `${restaurantId}:${sessionId}`;

export const waiterMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("waiter.call"),
    requestId: z.string().uuid("requestId must be a UUID"),
    payload: z.object({}).passthrough().optional(),
  }),
  z.object({
    type: z.literal("waiter.dismiss"),
    requestId: z.string().uuid("requestId must be a UUID"),
    payload: z.object({ sessionId: z.string().min(1, "sessionId is required") }),
  }),
]);

export const isWaiterMessage = (raw) => typeof raw?.type === "string" && raw.type.startsWith("waiter.");

const calledEvent = (call) => ({ type: "event", event: "waiter.called", data: call });

// A guest asks for a waiter. While their table's call is open, asking again
// changes nothing and alerts no one a second time.
const callWaiter = async (auth) => {
  if (auth.role !== "guest") throw new AppError("FORBIDDEN", "Only guests call a waiter", 403);
  const key = keyOf(auth.restaurantId, auth.sessionId);
  const open = calls.get(key);
  if (open) return open;
  const table = await findCallingTable(auth.restaurantId, auth.sessionId);
  // Another call from the same table may have landed while we looked the table up.
  if (calls.has(key)) return calls.get(key);
  const call = { ...table, calledAt: new Date().toISOString() };
  calls.set(key, call);
  publish({ restaurantId: auth.restaurantId, sessionId: call.sessionId, message: calledEvent(call) });
  return call;
};

// Staff answer a call. Closing one that is already closed is a no-op, so two
// waiters tapping the same table do not trip over each other.
const dismissCall = (auth, sessionId) => {
  if (auth.role !== "employee") throw new AppError("FORBIDDEN", "Only staff close a waiter call", 403);
  if (!calls.delete(keyOf(auth.restaurantId, sessionId))) return;
  publish({
    restaurantId: auth.restaurantId,
    sessionId,
    message: { type: "event", event: "waiter.dismissed", data: { sessionId } },
  });
};

export const executeWaiterCommand = async (auth, message) => {
  if (message.type === "waiter.call") return { call: await callWaiter(auth) };
  dismissCall(auth, message.payload.sessionId);
  return { sessionId: message.payload.sessionId };
};

// A closed table has nobody left to serve.
export const forgetWaiterCall = (restaurantId, sessionId) => {
  calls.delete(keyOf(restaurantId, sessionId));
};

// What a socket that just joined should know: staff hear every open call of
// their restaurant, a guest only their own table's.
export const openWaiterCalls = (auth) => {
  if (auth.role === "guest") {
    const call = calls.get(keyOf(auth.restaurantId, auth.sessionId));
    return call ? [calledEvent(call)] : [];
  }
  const prefix = `${auth.restaurantId}:`;
  return [...calls.entries()].filter(([key]) => key.startsWith(prefix)).map(([, call]) => calledEvent(call));
};

export const resetWaiterCalls = () => {
  calls.clear();
};
