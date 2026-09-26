import mongoose from "mongoose";
import Restaurant from "../modules/restaurants/restaurant.model.js";

const TENANT_COLLECTIONS = ["tables", "menuitems", "orders", "tablesessions", "employees"];

const dropIfExists = async (collection, name) => {
  const indexes = await collection.indexes();
  if (indexes.some((index) => index.name === name)) {
    await collection.dropIndex(name);
  }
};

const collectionExists = async (db, name) => db.listCollections({ name }).hasNext();

export const migrateTenants = async () => {
  let restaurant = await Restaurant.findOne({ slug: "default" });
  if (!restaurant) {
    restaurant = await Restaurant.create({
      name: "Plate Vista",
      slug: "default",
      status: "active",
      settings: { currency: "EUR", timezone: "Europe/Berlin" },
    });
  }

  const db = mongoose.connection.db;
  for (const name of TENANT_COLLECTIONS) {
    if (!(await collectionExists(db, name))) continue;
    await db.collection(name).updateMany(
      { restaurantId: { $exists: false } },
      { $set: { restaurantId: restaurant._id } }
    );
  }

  if (await collectionExists(db, "tables")) {
    const tables = db.collection("tables");
    await tables.updateMany({}, { $unset: { orders: "" } });
    await dropIfExists(tables, "tableNumber_1");
  }
  if (await collectionExists(db, "menuitems")) {
    await dropIfExists(db.collection("menuitems"), "title_1");
  }

  const [{ default: Table }, { default: MenuItem }, { default: Order }, { default: TableSession }, { default: Employee }] =
    await Promise.all([
      import("../modules/tables/table.model.js"),
      import("../modules/menu/menuItem.model.js"),
      import("../modules/ordering/order.model.js"),
      import("../modules/ordering/session.model.js"),
      import("../modules/staff/employee.model.js"),
    ]);
  await Promise.all([
    Table.syncIndexes(),
    MenuItem.syncIndexes(),
    Order.syncIndexes(),
    TableSession.syncIndexes(),
    Employee.syncIndexes(),
  ]);

  return restaurant;
};
