import mongoose from "mongoose";
import { customAlphabet } from "nanoid";
import Table from "../tables/table.model.js";
import Order from "./order.model.js";
import TableSession from "./session.model.js";
import { AppError, duplicateKeyOn } from "../../shared/errors.js";
import { publish } from "../../realtime/events.js";
import { serializeOrder, serializeSession } from "./serialize.js";

// Short code guests read to each other at the table. No 0/O or 1/I.
const newJoinCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);

export const openOrJoinSession = async (restaurantId, tableId, mongoSession) => {
  const existingQuery = TableSession.findOne({
    restaurantId,
    tableId,
    status: "open",
  });
  if (mongoSession) existingQuery.session(mongoSession);
  const existing = await existingQuery;
  if (existing) return { session: existing, opened: false, tableNumber: null };

  const tableQuery = Table.findOne({ _id: tableId, restaurantId });
  if (mongoSession) tableQuery.session(mongoSession);
  const table = await tableQuery;
  if (!table) throw new AppError("NOT_FOUND", "Not found", 404);

  const [created] = await TableSession.create(
    [
      {
        restaurantId,
        tableId,
        status: "open",
        openedAt: new Date(),
        code: newJoinCode(),
      },
    ],
    { session: mongoSession || undefined }
  );

  const occupy = Table.updateOne(
    { _id: tableId, restaurantId },
    { $set: { status: "occupied" } }
  );
  if (mongoSession) occupy.session(mongoSession);
  await occupy;
  return { session: created, opened: true, tableNumber: table.tableNumber };
};

export const openOrJoinSessionSafe = async (restaurantId, tableId) =>
  (await openOrJoinSessionWithRetry(restaurantId, tableId)).session;

// Returns { session, opened } so the caller knows whether this request opened
// the session (first guest) or joined one that was already open.
export const openOrJoinSessionWithRetry = async (restaurantId, tableId) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await openOrJoinSession(restaurantId, tableId);
    } catch (error) {
      if (duplicateKeyOn(error) && attempt < 2) continue;
      throw error;
    }
  }
  throw new AppError("INTERNAL", "Could not open session");
};

export const findSession = async (restaurantId, sessionId, mongoSession) => {
  const query = TableSession.findOne({ _id: sessionId, restaurantId });
  if (mongoSession) query.session(mongoSession);
  const session = await query;
  if (!session) throw new AppError("NOT_FOUND", "Not found", 404);
  return session;
};

export const assertOpenSession = async (restaurantId, sessionId) => {
  const session = await findSession(restaurantId, sessionId);
  if (session.status !== "open") {
    throw new AppError("SESSION_CLOSED", "Session is closed");
  }
  return session;
};

export const closeSession = async (ctx, sessionId) => {
  const mongoSession = await mongoose.startSession();
  try {
    let closed;
    let didClose = false;
    await mongoSession.withTransaction(async () => {
      const session = await TableSession.findOne({
        _id: sessionId,
        restaurantId: ctx.restaurantId,
      }).session(mongoSession);
      if (!session) throw new AppError("NOT_FOUND", "Not found", 404);
      if (session.status === "closed") {
        closed = session;
        return;
      }
      session.status = "closed";
      session.closedAt = new Date();
      await session.save({ session: mongoSession });
      await Table.updateOne(
        { _id: session.tableId, restaurantId: ctx.restaurantId },
        { $set: { status: "vacant" } }
      ).session(mongoSession);
      closed = session;
      didClose = true;
    });
    if (didClose) {
      publish({
        restaurantId: ctx.restaurantId,
        sessionId: closed._id,
        message: {
          type: "event",
          event: "session.closed",
          data: { sessionId: String(closed._id), tableId: String(closed.tableId) },
        },
      });
    }
    return closed;
  } finally {
    await mongoSession.endSession();
  }
};

// The open session is the source of truth for "occupied"; the stored status
// can be stale (set by older code, or a close that never reached the table).
export const tableStatus = (table, openTableIds) => {
  if (openTableIds.has(String(table._id))) return "occupied";
  return table.status === "reserved" ? "reserved" : "vacant";
};

export const RECENTLY_CLOSED_MS = 12 * 60 * 60 * 1000;

const billTotals = async (restaurantId, sessionIds) => {
  if (sessionIds.length === 0) return new Map();
  const rows = await Order.aggregate([
    {
      $match: {
        restaurantId: new mongoose.Types.ObjectId(String(restaurantId)),
        sessionId: { $in: sessionIds },
        status: { $ne: "cancelled" },
      },
    },
    { $group: { _id: "$sessionId", totalCents: { $sum: "$totalCents" } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.totalCents]));
};

export const getBoard = async (restaurantId) => {
  const [sessions, closed] = await Promise.all([
    TableSession.find({ restaurantId, status: "open" }).lean(),
    TableSession.find({
      restaurantId,
      status: "closed",
      closedAt: { $gte: new Date(Date.now() - RECENTLY_CLOSED_MS) },
    })
      .sort({ closedAt: -1 })
      .limit(50)
      .lean(),
  ]);
  const sessionIds = sessions.map((session) => session._id);
  const [orders, tables, closedTotals] = await Promise.all([
    Order.find({
      restaurantId,
      sessionId: { $in: sessionIds },
      status: { $ne: "cancelled" },
    }).lean(),
    // Every table: the floor plan shows free tables too, not only seated ones.
    Table.find({ restaurantId })
      .select("tableNumber capacity status qrCode")
      .lean(),
    billTotals(restaurantId, closed.map((session) => session._id)),
  ]);
  const tableById = new Map(tables.map((table) => [String(table._id), table]));
  const tableNumberOf = (session) => tableById.get(String(session.tableId))?.tableNumber ?? null;
  const openTableIds = new Set(sessions.map((session) => String(session.tableId)));
  return {
    // Staff see the join code so a waiter can tell guests who scan late.
    sessions: sessions.map((session) => ({
      ...serializeSession(session, tableNumberOf(session)),
      joinCode: session.code,
    })),
    // Closed sessions keep their orders; fetch them with GET /sessions/:id/bill.
    recentlyClosed: closed.map((session) => ({
      ...serializeSession(session, tableNumberOf(session)),
      totalCents: closedTotals.get(String(session._id)) || 0,
    })),
    orders: orders.map((order) => serializeOrder(order)),
    tables: tables.map((table) => ({
      _id: String(table._id),
      tableNumber: table.tableNumber,
      capacity: table.capacity,
      status: tableStatus(table, openTableIds),
      qrCode: table.qrCode,
    })),
  };
};
