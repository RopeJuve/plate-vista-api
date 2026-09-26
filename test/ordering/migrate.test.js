process.env.JWT_SECRET = "test-secret-migration";
process.env.NODE_ENV = "test";

import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { connectToDatabase, disconnectDatabase } from "../../src/db/db.js";

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_DB_URL = mongod.getUri();
  await connectToDatabase();
}, { timeout: 120000 });

test.after(async () => {
  await disconnectDatabase();
  await mongod?.stop();
});

test("tenant migration backfills restaurantId and can run twice", async () => {
  const { migrateTenants } = await import("../../src/db/migrateTenants.js");
  const { default: Restaurant } = await import("../../src/modules/restaurants/restaurant.model.js");
  const { default: MenuItem } = await import("../../src/modules/menu/menuItem.model.js");
  const { default: Table } = await import("../../src/modules/tables/table.model.js");
  const db = mongoose.connection.db;

  await db.collection("menuitems").createIndex({ title: 1 }, { unique: true, name: "title_1" });
  await db.collection("menuitems").insertOne({
    title: "Pizza",
    description: "desc",
    price: 10,
    image: "x.png",
    category: "food",
  });
  await db.collection("tables").createIndex({ tableNumber: 1 }, { unique: true, name: "tableNumber_1" });
  const legacyOrderId = new mongoose.Types.ObjectId();
  await db.collection("tables").insertOne({
    tableNumber: 1,
    capacity: 4,
    status: "occupied",
    orders: [legacyOrderId],
  });

  const first = await migrateTenants();
  const second = await migrateTenants();
  assert.equal(String(first._id), String(second._id));
  assert.equal(await Restaurant.countDocuments({ slug: "default" }), 1);

  const pizza = await db.collection("menuitems").findOne({ title: "Pizza" });
  const table = await db.collection("tables").findOne({ tableNumber: 1, restaurantId: first._id });
  assert.equal(String(pizza.restaurantId), String(first._id));
  assert.equal(table.orders, undefined);
  const indexes = await db.collection("menuitems").indexes();
  assert.equal(indexes.some((index) => index.name === "title_1"), false);

  const other = await Restaurant.create({ name: "Other", slug: "other" });
  await MenuItem.create({
    restaurantId: other._id,
    title: "Pizza",
    description: "desc",
    price: 12,
    priceCents: 1200,
    image: "y.png",
    category: "food",
  });
  await Table.create({
    restaurantId: other._id,
    tableNumber: 1,
    capacity: 2,
  });
  assert.equal(await MenuItem.countDocuments({ title: "Pizza" }).setOptions({ skipTenant: true }), 2);
});
