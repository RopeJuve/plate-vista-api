import mongoose from "mongoose";
import Order from "./order.model.js";
import { AppError, duplicateKeyOn } from "../../shared/errors.js";
import { parseOrThrow } from "../../shared/validate.js";
import { logger, captureException } from "../../shared/logger.js";
import { publish } from "../../realtime/events.js";
import { priceItems } from "./pricing.js";
import { stock } from "./stock.js";
import { assertTransition } from "./order.transitions.js";
import { buildTickets, orderStatusOf, stationOf, ticketFields, ticketsOf } from "./tickets.js";
import {
  cancelOrderSchema,
  createOrderSchema,
  statusOrderSchema,
  updateOrderSchema,
} from "./order.schemas.js";
import TableSession from "./session.model.js";
import { findSession, openOrJoinSession } from "./session.service.js";
import { serializeOrder, serializeSession } from "./serialize.js";

export { serializeOrder };

const runTransaction = async (work) => {
  const mongoSession = await mongoose.startSession();
  try {
    return await mongoSession.withTransaction(() => work(mongoSession));
  } finally {
    await mongoSession.endSession();
  }
};

const publishOrder = (restaurantId, sessionId, event, data) => {
  publish({
    restaurantId,
    sessionId,
    message: { type: "event", event, data },
  });
};

const publishStaff = (restaurantId, event, data) => {
  publish({
    restaurantId,
    audience: "staff",
    message: { type: "event", event, data },
  });
};

const logFailure = (ctx, sessionId, error) => {
  logger.error(
    {
      restaurantId: ctx.restaurantId,
      sessionId: sessionId || ctx.actor?.sessionId || null,
      requestId: ctx.requestId || null,
      err: error,
    },
    "order failed"
  );
  captureException(error);
};

const findOpenSession = async (restaurantId, sessionId, mongoSession) => {
  const session = await findSession(restaurantId, sessionId, mongoSession);
  if (session.status !== "open") {
    throw new AppError("SESSION_CLOSED", "Session is closed");
  }
  return session;
};

const resolveSession = async (ctx, payload, mongoSession) => {
  if (ctx.actor?.type === "guest") {
    const session = await assertBoundGuestSession(ctx, mongoSession);
    return { session, opened: false, tableNumber: null };
  }
  if (payload.sessionId) {
    const session = await findOpenSession(ctx.restaurantId, payload.sessionId, mongoSession);
    return { session, opened: false, tableNumber: null };
  }
  if (payload.tableId) {
    return openOrJoinSession(ctx.restaurantId, payload.tableId, mongoSession);
  }
  throw new AppError("VALIDATION", "sessionId or tableId is required", 400, {
    fields: { tableId: "sessionId or tableId is required" },
  });
};

const assertBoundGuestSession = async (ctx, mongoSession) => {
  const session = await findOpenSession(ctx.restaurantId, ctx.actor.sessionId, mongoSession);
  if (ctx.actor.tableId && String(session.tableId) !== String(ctx.actor.tableId)) {
    throw new AppError("FORBIDDEN", "Forbidden");
  }
  return session;
};

// Reading the session is not enough: a close that commits while this
// transaction runs touches a different document, so both would commit and the
// order would land in a closed session. Writing the session document makes the
// two transactions conflict; withTransaction retries and re-reads the status.
const touchOpenSession = async (restaurantId, sessionId, mongoSession) => {
  const result = await TableSession.updateOne(
    { _id: sessionId, restaurantId, status: "open" },
    { $set: { lastOrderAt: new Date() } }
  ).session(mongoSession);
  if (result.matchedCount === 0) {
    throw new AppError("SESSION_CLOSED", "Session is closed");
  }
};

const quantityMap = (items, key) => {
  const map = new Map();
  items.forEach((item) => {
    const id = String(item[key]);
    map.set(id, (map.get(id) || 0) + item.quantity);
  });
  return map;
};

// Matches the order only if nothing has changed it since it was read.
const unchanged = (order) => ({
  _id: order._id,
  restaurantId: order.restaurantId,
  rev: order.rev,
});

// The tickets a message is about: the named station's, or without a station
// the ones holding the order back (every ticket, when they are level).
const ticketsFor = (tickets, station) => {
  if (station) {
    const ticket = tickets.find((candidate) => candidate.station === station);
    if (!ticket) throw new AppError("NOT_FOUND", `This order has no ${station} ticket`, 404);
    return [ticket];
  }
  const status = orderStatusOf(tickets);
  return tickets.filter((ticket) => ticket.status === status);
};

const statusChange = (order, station) => ({
  orderId: order._id,
  status: order.status,
  rev: order.rev,
  tickets: order.tickets,
  totalCents: order.totalCents,
  ...(station ? { station } : {}),
});

const findExisting = async (restaurantId, clientOrderId) =>
  Order.findOne({ restaurantId, clientOrderId });

export const createOrder = async (ctx, input) => {
  let sessionId = ctx.actor?.sessionId || null;
  try {
    const payload = parseOrThrow(createOrderSchema, input);
    sessionId = sessionId || payload.sessionId || null;
    const existing = await findExisting(ctx.restaurantId, payload.clientOrderId);
    if (existing) return { order: serializeOrder(existing), replayed: true };

    let saved;
    let openedMeta = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        saved = await runTransaction(async (mongoSession) => {
          openedMeta = null;
          const resolved = await resolveSession(ctx, payload, mongoSession);
          const session = resolved.session;
          sessionId = String(session._id);
          if (resolved.opened) {
            openedMeta = { session, tableNumber: resolved.tableNumber };
          }
          const priced = await priceItems(ctx.restaurantId, payload.items, mongoSession);
          const byEmployeeId = ctx.actor?.type === "employee" ? ctx.actor.id : null;
          const [order] = await Order.create(
            [
              {
                restaurantId: ctx.restaurantId,
                tableId: session.tableId,
                sessionId: session._id,
                clientOrderId: payload.clientOrderId,
                userId:
                  (ctx.actor?.type === "guest" || ctx.actor?.type === "user") && ctx.actor.id
                    ? ctx.actor.id
                    : undefined,
                items: priced.items,
                tickets: buildTickets(priced.items),
                totalCents: priced.totalCents,
                status: "pending",
                rev: 1,
                statusHistory: [{ status: "pending", at: new Date(), byEmployeeId }],
              },
            ],
            { session: mongoSession }
          );
          await stock.adjust(
            priced.items.map((item) => ({ productId: item.productId, delta: item.quantity })),
            ctx.restaurantId,
            mongoSession
          );
          if (stock.afterSave) await stock.afterSave();
          await touchOpenSession(ctx.restaurantId, session._id, mongoSession);
          return order;
        });
        break;
      } catch (error) {
        const dup = duplicateKeyOn(error);
        if (dup === "clientOrderId" || dup === "unknown") {
          const again = await findExisting(ctx.restaurantId, payload.clientOrderId);
          if (again) return { order: serializeOrder(again), replayed: true };
        }
        if (dup === "tableId" && attempt < 2) continue;
        throw error;
      }
    }

    const order = serializeOrder(saved);
    if (openedMeta) {
      publishStaff(ctx.restaurantId, "session.opened", {
        session: {
          ...serializeSession(openedMeta.session, openedMeta.tableNumber),
          joinCode: openedMeta.session.code,
        },
      });
    }
    publishOrder(ctx.restaurantId, order.sessionId, "order.created", { order });
    return { order, replayed: false };
  } catch (error) {
    logFailure(ctx, sessionId, error);
    throw error;
  }
};

export const updateOrder = async (ctx, input) => {
  let sessionId = ctx.actor?.sessionId || null;
  try {
    const payload = parseOrThrow(updateOrderSchema, input);
    const order = await runTransaction(async (mongoSession) => {
      const current = await Order.findOne({
        _id: payload.orderId,
        restaurantId: ctx.restaurantId,
      }).session(mongoSession);
      if (!current) throw new AppError("NOT_FOUND", "Not found", 404);
      sessionId = String(current.sessionId);
      if (ctx.actor?.type === "guest" && String(current.sessionId) !== String(ctx.actor.sessionId)) {
        throw new AppError("NOT_FOUND", "Not found", 404);
      }
      if (ctx.actor?.type === "guest") {
        await assertBoundGuestSession(ctx, mongoSession);
      }
      // Once any station has started on its ticket the order is locked.
      const started = ticketsOf(current).find((ticket) => ticket.status !== "pending");
      if (started) {
        throw new AppError(
          "INVALID_TRANSITION",
          "Only pending orders can be edited",
          undefined,
          { from: started.status, to: "pending" }
        );
      }
      const priced = await priceItems(ctx.restaurantId, payload.items, mongoSession);
      const previous = quantityMap(current.items, "productId");
      const next = quantityMap(priced.items, "productId");
      const productIds = new Set([...previous.keys(), ...next.keys()]);
      const deltas = [...productIds].map((productId) => ({
        productId,
        delta: (next.get(productId) || 0) - (previous.get(productId) || 0),
      }));
      const updated = await Order.findOneAndUpdate(
        unchanged(current),
        {
          $set: {
            items: priced.items,
            tickets: buildTickets(priced.items),
            totalCents: priced.totalCents,
          },
          $inc: { rev: 1 },
        },
        { new: true, session: mongoSession }
      );
      if (!updated) {
        throw new AppError("INVALID_TRANSITION", "Only pending orders can be edited", undefined, {
          from: current.status,
          to: "pending",
        });
      }
      await stock.adjust(deltas, ctx.restaurantId, mongoSession);
      await touchOpenSession(ctx.restaurantId, current.sessionId, mongoSession);
      return updated;
    });
    const dto = serializeOrder(order);
    publishOrder(ctx.restaurantId, dto.sessionId, "order.updated", { order: dto });
    return { order: dto };
  } catch (error) {
    logFailure(ctx, sessionId, error);
    throw error;
  }
};

export const changeStatus = async (ctx, input) => {
  let sessionId = ctx.actor?.sessionId || null;
  try {
    const payload = parseOrThrow(statusOrderSchema, input);
    const order = await Order.findOne({
      _id: payload.orderId,
      restaurantId: ctx.restaurantId,
    });
    if (!order) throw new AppError("NOT_FOUND", "Not found", 404);
    if (ctx.actor?.type !== "employee") {
      throw new AppError("FORBIDDEN", "Forbidden");
    }
    sessionId = String(order.sessionId);
    if (payload.status === "cancelled") {
      return cancelOrder(ctx, {
        orderId: payload.orderId,
        reason: "Cancelled",
        station: payload.station,
      });
    }
    const tickets = ticketsOf(order);
    const moving = ticketsFor(tickets, payload.station);
    if (moving.length === 0) assertTransition("cancelled", payload.status);
    moving.forEach((ticket) => assertTransition(ticket.status, payload.status));
    const from = moving[0].status;
    moving.forEach((ticket) => {
      ticket.status = payload.status;
    });
    const updated = await Order.findOneAndUpdate(
      unchanged(order),
      {
        $set: ticketFields(order, tickets),
        $push: {
          statusHistory: {
            status: payload.status,
            at: new Date(),
            byEmployeeId: ctx.actor.id,
            ...(payload.station ? { station: payload.station } : {}),
          },
        },
        $inc: { rev: 1 },
      },
      { new: true }
    );
    if (!updated) {
      throw new AppError(
        "INVALID_TRANSITION",
        `Cannot change status from ${from} to ${payload.status}`,
        undefined,
        { from, to: payload.status }
      );
    }
    const dto = serializeOrder(updated);
    publishOrder(
      ctx.restaurantId,
      dto.sessionId,
      "order.statusChanged",
      statusChange(dto, payload.station)
    );
    return { order: dto };
  } catch (error) {
    logFailure(ctx, sessionId, error);
    throw error;
  }
};

export const cancelOrder = async (ctx, input) => {
  let sessionId = ctx.actor?.sessionId || null;
  try {
    if (ctx.actor?.type !== "employee" && ctx.actor?.type !== "guest") {
      throw new AppError("FORBIDDEN", "Forbidden");
    }
    const payload = parseOrThrow(cancelOrderSchema, input);
    const order = await runTransaction(async (mongoSession) => {
      const current = await Order.findOne({
        _id: payload.orderId,
        restaurantId: ctx.restaurantId,
      }).session(mongoSession);
      if (!current) throw new AppError("NOT_FOUND", "Not found", 404);
      sessionId = String(current.sessionId);
      if (ctx.actor.type === "guest" && String(current.sessionId) !== String(ctx.actor.sessionId)) {
        throw new AppError("NOT_FOUND", "Not found", 404);
      }
      const tickets = ticketsOf(current);
      if (ctx.actor.type === "guest") {
        await assertBoundGuestSession(ctx, mongoSession);
        // A guest cancels the whole order, and only before any station started.
        if (payload.station) throw new AppError("FORBIDDEN", "Forbidden");
        const started = tickets.find(
          (ticket) => ticket.status !== "pending" && ticket.status !== "cancelled"
        );
        if (started) {
          throw new AppError(
            "INVALID_TRANSITION",
            `Cannot change status from ${started.status} to cancelled`,
            undefined,
            { from: started.status, to: "cancelled" }
          );
        }
      }
      const cancelling = payload.station
        ? ticketsFor(tickets, payload.station)
        : tickets.filter((ticket) => ticket.status !== "cancelled");
      if (cancelling.length === 0) assertTransition("cancelled", "cancelled");
      cancelling.forEach((ticket) => assertTransition(ticket.status, "cancelled"));
      const stations = new Set(cancelling.map((ticket) => ticket.station));
      await stock.adjust(
        current.items
          .filter((item) => stations.has(stationOf(item)))
          .map((item) => ({ productId: item.productId, delta: -item.quantity })),
        ctx.restaurantId,
        mongoSession
      );
      const reason = payload.reason || "";
      cancelling.forEach((ticket) => {
        ticket.status = "cancelled";
        ticket.cancelReason = reason;
      });
      const fields = ticketFields(current, tickets);
      const wholeOrder = fields.status === "cancelled";
      const updated = await Order.findOneAndUpdate(
        unchanged(current),
        {
          $set: {
            ...fields,
            ...(wholeOrder ? { cancelReason: reason } : {}),
            ...(wholeOrder && ctx.actor.type === "employee" ? { cancelledBy: ctx.actor.id } : {}),
          },
          $push: {
            statusHistory: {
              status: "cancelled",
              at: new Date(),
              byEmployeeId: ctx.actor.type === "employee" ? ctx.actor.id : null,
              ...(payload.station ? { station: payload.station } : {}),
            },
          },
          $inc: { rev: 1 },
        },
        { new: true, session: mongoSession }
      );
      if (!updated) throw new AppError("NOT_FOUND", "Not found", 404);
      return updated;
    });
    const dto = serializeOrder(order);
    publishOrder(ctx.restaurantId, dto.sessionId, "order.statusChanged", {
      ...statusChange(dto, payload.station),
      reason: payload.reason || "",
    });
    return { order: dto };
  } catch (error) {
    logFailure(ctx, sessionId, error);
    throw error;
  }
};

// Works for open and closed sessions, so a closed table's bill stays readable.
export const getSessionBill = async (ctx, sessionId) => {
  const session = await findSession(ctx.restaurantId, sessionId);
  const orders = await Order.find({
    restaurantId: ctx.restaurantId,
    sessionId,
    status: { $ne: "cancelled" },
  }).lean();
  const totalCents = orders.reduce((sum, order) => sum + order.totalCents, 0);
  return {
    sessionId: String(sessionId),
    session: serializeSession(session),
    orders: orders.map((order) => serializeOrder(order)),
    totalCents,
  };
};

export const getOrder = async (restaurantId, orderId) => {
  const order = await Order.findOne({ _id: orderId, restaurantId });
  if (!order) throw new AppError("NOT_FOUND", "Not found", 404);
  return serializeOrder(order);
};

export const listOrders = async (restaurantId, { skip, limit }) => {
  const filter = { restaurantId };
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  return { orders: orders.map((order) => serializeOrder(order)), total };
};

export const anonymizeUser = async (userId) => {
  await Order.updateMany({ userId }, { $set: { userId: null } }).setOptions({ skipTenant: true });
};

export const executeOrderCommand = async (ctx, command) => {
  switch (command.type) {
    case "order.create":
      return createOrder(ctx, command.payload);
    case "order.update":
      return updateOrder(ctx, command.payload);
    case "order.cancel":
      return cancelOrder(ctx, command.payload);
    case "order.status":
      return changeStatus(ctx, command.payload);
    default:
      throw new AppError("VALIDATION", "Unknown message type");
  }
};
