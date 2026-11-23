import Table from "./table.model.js";

// The table number of each of the restaurant's tables given, by table id.
export const tableNumbersOf = async (restaurantId, tableIds, mongoSession = null) => {
  const tables = await Table.find({ restaurantId, _id: { $in: tableIds } })
    .select("tableNumber")
    .session(mongoSession)
    .lean();
  return new Map(tables.map((table) => [String(table._id), table.tableNumber]));
};
