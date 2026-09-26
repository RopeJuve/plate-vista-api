import mongoose from "mongoose";
import { nanoid } from "nanoid";
import Table from "../tables/table.model.js";
import Order from "./order.model.js";
import TableSession from "./session.model.js";
import { AppError, duplicateKeyOn } from "../../shared/errors.js";
import { publish } from "../../realtime/events.js";

export const openOrJoinSession = async (restaurantId, tableId, mongoSession) => {
  const existingQuery = TableSession.findOne({
    restaurantId,
    tableId,
    status: "open",
  });
  if (mongoSession) existingQuery.session(mongoSession);
  const existing = await existingQuery;
  if (existing) return existing;

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
        code: nanoid(10),
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
  return created;
};

export const openOrJoinSessionSafe = async (restaurantId, tableId) => {
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

export const assertOpenSession = async (restaurantId, sessionId) => {
  const session = await TableSession.findOne({ _id: sessionId, restaurantId });
  if (!session) throw new AppError("NOT_FOUND", "Not found", 404);
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
          data: { sessionId: closed._id, tableId: closed.tableId },
        },
      });
    }
    return closed;
  } finally {
    await mongoSession.endSession();
  }
};

export const getBoard = async (restaurantId) => {
  const sessions = await TableSession.find({ restaurantId, status: "open" }).lean();
  const sessionIds = sessions.map((session) => session._id);
  const tableIds = sessions.map((session) => session.tableId);
  const [orders, tables] = await Promise.all([
    Order.find({
      restaurantId,
      sessionId: { $in: sessionIds },
      status: { $ne: "cancelled" },
    }).lean(),
    Table.find({ restaurantId, _id: { $in: tableIds } })
      .select("tableNumber capacity status qrCode")
      .lean(),
  ]);
  return { sessions, orders, tables };
};
