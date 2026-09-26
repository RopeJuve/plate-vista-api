import mongoose from "mongoose";
import Order from "./order.model.js";
import { AppError, duplicateKeyOn } from "../../shared/errors.js";
import { parseOrThrow } from "../../shared/validate.js";
import { logger, captureException } from "../../shared/logger.js";
import { publish } from "../../realtime/events.js";
import { priceItems } from "./pricing.js";
import { stock } from "./stock.js";
import { assertTransition } from "./order.transitions.js";
import {
  cancelOrderSchema,
  createOrderSchema,
  statusOrderSchema,
  updateOrderSchema,
} from "./order.schemas.js";
import { assertOpenSession, openOrJoinSession } from "./session.service.js";

const idOf = (value) => (value == null ? null : String(value));

export const toOrderDTO = (order) => {
  const source = order.toObject ? order.toObject() : order;
  return {
    id: idOf(source._id),
    _id: idOf(source._id),
    restaurantId: idOf(source.restaurantId),
    tableId: idOf(source.tableId),
    sessionId: idOf(source.sessionId),
    clientOrderId: source.clientOrderId,
    userId: idOf(source.userId),
    items: (source.items || []).map((item) => ({
      productId: idOf(item.productId),
      title: item.title,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      lineTotalCents: item.lineTotalCents,
      notes: item.notes || "",
      status: item.status,
      station: item.station,
    })),
    totalCents: source.totalCents,
    status: source.status,
    statusHistory: (source.statusHistory || []).map((entry) => ({
      status: entry.status,
      at: entry.at,
      byEmployeeId: idOf(entry.byEmployeeId),
    })),
    cancelReason: source.cancelReason || null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
};

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

const resolveSession = async (ctx, payload, mongoSession) => {
  if (ctx.actor?.type === "guest") {
    const session = await assertBoundGuestSession(ctx, mongoSession);
    return session;
  }
  if (payload.sessionId) {
    const session = await TableSessionFind(ctx.restaurantId, payload.sessionId, mongoSession);
    if (session.status !== "open") {
      throw new AppError("SESSION_CLOSED", "Session is closed");
    }
    return session;
  }
  if (payload.tableId) {
    return openOrJoinSession(ctx.restaurantId, payload.tableId, mongoSession);
  }
  throw new AppError("VALIDATION", "sessionId or tableId is required");
};

const TableSessionFind = async (restaurantId, sessionId, mongoSession) => {
  const { default: TableSession } = await import("./session.model.js");
  const query = TableSession.findOne({ _id: sessionId, restaurantId });
  if (mongoSession) query.session(mongoSession);
  const session = await query;
  if (!session) throw new AppError("NOT_FOUND", "Not found", 404);
  return session;
};

const assertBoundGuestSession = async (ctx, mongoSession) => {
  const { default: TableSession } = await import("./session.model.js");
  const query = TableSession.findOne({
    _id: ctx.actor.sessionId,
    restaurantId: ctx.restaurantId,
  });
  if (mongoSession) query.session(mongoSession);
  const session = await query;
  if (!session) throw new AppError("NOT_FOUND", "Not found", 404);
  if (session.status !== "open") {
    throw new AppError("SESSION_CLOSED", "Session is closed");
  }
  if (ctx.actor.tableId && String(session.tableId) !== String(ctx.actor.tableId)) {
    throw new AppError("FORBIDDEN", "Forbidden");
  }
  return session;
};

const quantityMap = (items, key) => {
  const map = new Map();
  items.forEach((item) => {
    const id = String(item[key]);
    map.set(id, (map.get(id) || 0) + item.quantity);
  });
  return map;
};

const findExisting = async (restaurantId, clientOrderId) =>
  Order.findOne({ restaurantId, clientOrderId });

export const createOrder = async (ctx, input) => {
  let sessionId = ctx.actor?.sessionId || null;
  try {
    const payload = parseOrThrow(createOrderSchema, input);
    sessionId = sessionId || payload.sessionId || null;
    const existing = await findExisting(ctx.restaurantId, payload.clientOrderId);
    if (existing) return { order: toOrderDTO(existing), replayed: true };

    let saved;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        saved = await runTransaction(async (mongoSession) => {
          const session = await resolveSession(ctx, payload, mongoSession);
          sessionId = String(session._id);
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
                totalCents: priced.totalCents,
                status: "pending",
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
          return order;
        });
        break;
      } catch (error) {
        const dup = duplicateKeyOn(error);
        if (dup === "clientOrderId" || dup === "unknown") {
          const again = await findExisting(ctx.restaurantId, payload.clientOrderId);
          if (again) return { order: toOrderDTO(again), replayed: true };
        }
        if (dup === "tableId" && attempt < 2) continue;
        throw error;
      }
    }

    const order = toOrderDTO(saved);
    publishOrder(ctx.restaurantId, order.sessionId, "order.created", { order });
    return { order, replayed: false };
  } catch (error) {
    logFailure(ctx, sessionId, error);
    throw error;
  }
};

export const addRound = (ctx, input) => createOrder(ctx, input);

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
      if (current.status !== "pending") {
        throw new AppError("INVALID_TRANSITION", "Only pending orders can be edited");
      }
      if (ctx.actor?.type === "guest" && String(current.sessionId) !== String(ctx.actor.sessionId)) {
        throw new AppError("FORBIDDEN", "Forbidden");
      }
      if (ctx.actor?.type === "guest") {
        await assertBoundGuestSession(ctx, mongoSession);
      }
      const priced = await priceItems(ctx.restaurantId, payload.items, mongoSession);
      const previous = quantityMap(current.items, "productId");
      const next = quantityMap(priced.items, "productId");
      const productIds = new Set([...previous.keys(), ...next.keys()]);
      const deltas = [...productIds].map((productId) => ({
        productId,
        delta: (next.get(productId) || 0) - (previous.get(productId) || 0),
      }));
      current.items = priced.items;
      current.totalCents = priced.totalCents;
      await current.save({ session: mongoSession });
      await stock.adjust(deltas, ctx.restaurantId, mongoSession);
      return current;
    });
    const dto = toOrderDTO(order);
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
    if (ctx.actor?.type !== "employee") {
      throw new AppError("FORBIDDEN", "Forbidden");
    }
    const payload = parseOrThrow(statusOrderSchema, input);
    const order = await Order.findOne({
      _id: payload.orderId,
      restaurantId: ctx.restaurantId,
    });
    if (!order) throw new AppError("NOT_FOUND", "Not found", 404);
    sessionId = String(order.sessionId);
    assertTransition(order.status, payload.status);
    if (payload.status === "cancelled") {
      return cancelOrder(ctx, { orderId: payload.orderId, reason: "Cancelled" });
    }
    order.status = payload.status;
    order.items.forEach((item) => {
      item.status = payload.status;
    });
    order.statusHistory.push({
      status: payload.status,
      at: new Date(),
      byEmployeeId: ctx.actor.id,
    });
    await order.save();
    const dto = toOrderDTO(order);
    publishOrder(ctx.restaurantId, dto.sessionId, "order.statusChanged", {
      orderId: dto.id,
      status: dto.status,
    });
    return { order: dto };
  } catch (error) {
    logFailure(ctx, sessionId, error);
    throw error;
  }
};

export const cancelOrder = async (ctx, input) => {
  let sessionId = ctx.actor?.sessionId || null;
  try {
    if (ctx.actor?.type !== "employee") {
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
      assertTransition(current.status, "cancelled");
      await stock.adjust(
        current.items.map((item) => ({ productId: item.productId, delta: -item.quantity })),
        ctx.restaurantId,
        mongoSession
      );
      current.status = "cancelled";
      current.cancelReason = payload.reason || "";
      current.cancelledBy = ctx.actor.id;
      current.items.forEach((item) => {
        item.status = "cancelled";
      });
      current.statusHistory.push({
        status: "cancelled",
        at: new Date(),
        byEmployeeId: ctx.actor.id,
      });
      await current.save({ session: mongoSession });
      return current;
    });
    const dto = toOrderDTO(order);
    publishOrder(ctx.restaurantId, dto.sessionId, "order.statusChanged", {
      orderId: dto.id,
      status: "cancelled",
    });
    return { order: dto };
  } catch (error) {
    logFailure(ctx, sessionId, error);
    throw error;
  }
};

export const getSessionBill = async (ctx, sessionId) => {
  await assertOpenOrAny(ctx.restaurantId, sessionId);
  const orders = await Order.find({
    restaurantId: ctx.restaurantId,
    sessionId,
    status: { $ne: "cancelled" },
  }).lean();
  const totalCents = orders.reduce((sum, order) => sum + order.totalCents, 0);
  return {
    sessionId: String(sessionId),
    orders: orders.map((order) => toOrderDTO(order)),
    totalCents,
  };
};

const assertOpenOrAny = async (restaurantId, sessionId) => {
  const { default: TableSession } = await import("./session.model.js");
  const session = await TableSession.findOne({ _id: sessionId, restaurantId });
  if (!session) throw new AppError("NOT_FOUND", "Not found", 404);
  return session;
};

export const getOrder = async (restaurantId, orderId) => {
  const order = await Order.findOne({ _id: orderId, restaurantId });
  if (!order) throw new AppError("NOT_FOUND", "Not found", 404);
  return toOrderDTO(order);
};

export const listOrders = async (restaurantId, { skip, limit }) => {
  const filter = { restaurantId };
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  return { orders: orders.map((order) => toOrderDTO(order)), total };
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

export { assertOpenSession };
