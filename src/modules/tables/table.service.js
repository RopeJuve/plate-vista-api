import { nanoid } from "nanoid";
import Restaurant from "../restaurants/restaurant.model.js";
import Table from "./table.model.js";
import TableSession from "../ordering/session.model.js";
import { tableStatus } from "../ordering/session.service.js";
import { AppError, isDuplicateKey } from "../../shared/errors.js";

const withPath = async (table) => {
  const source = table.toObject ? table.toObject() : table;
  const restaurant = await Restaurant.findById(source.restaurantId);
  return {
    ...source,
    qrPath: restaurant ? `/r/${restaurant.slug}/t/${source.qrCode}` : null,
  };
};

export const listTables = async (restaurantId) => {
  const [tables, restaurant, openSessions] = await Promise.all([
    Table.find({ restaurantId }).lean(),
    Restaurant.findById(restaurantId),
    TableSession.find({ restaurantId, status: "open" }).select("tableId").lean(),
  ]);
  const openTableIds = new Set(openSessions.map((session) => String(session.tableId)));
  return tables.map((table) => ({
    ...table,
    status: tableStatus(table, openTableIds),
    qrPath: restaurant ? `/r/${restaurant.slug}/t/${table.qrCode}` : null,
  }));
};

export const getTable = async (restaurantId, id) => {
  const table = await Table.findOne({ _id: id, restaurantId });
  if (!table) throw new AppError("NOT_FOUND", "Not found", 404);
  return withPath(table);
};

export const createTable = async (restaurantId, input) => {
  try {
    const table = await Table.create({
      restaurantId,
      tableNumber: input.tableNumber,
      capacity: input.capacity,
      status: input.status || "vacant",
      qrCode: nanoid(12),
    });
    return withPath(table);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError("VALIDATION", "Table number already exists", 409);
    }
    throw error;
  }
};

export const updateTable = async (restaurantId, id, input) => {
  const table = await Table.findOneAndUpdate(
    { _id: id, restaurantId },
    input,
    { new: true, runValidators: true }
  );
  if (!table) throw new AppError("NOT_FOUND", "Not found", 404);
  return withPath(table);
};

export const deleteTable = async (restaurantId, id) => {
  const table = await Table.findOneAndDelete({ _id: id, restaurantId });
  if (!table) throw new AppError("NOT_FOUND", "Not found", 404);
};

export const regenerateQrCode = async (restaurantId, id) => {
  const table = await Table.findOneAndUpdate(
    { _id: id, restaurantId },
    { qrCode: nanoid(12) },
    { new: true }
  );
  if (!table) throw new AppError("NOT_FOUND", "Not found", 404);
  return withPath(table);
};

export const findByQrCode = async (qrCode) => {
  const table = await Table.findOne({ qrCode }).setOptions({ skipTenant: true });
  if (!table) throw new AppError("NOT_FOUND", "Not found", 404);
  return table;
};
