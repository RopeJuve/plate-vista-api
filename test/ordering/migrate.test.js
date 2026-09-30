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
  await db.collection("tables").insertMany([
    {
      tableNumber: 1,
      capacity: 4,
      status: "occupied",
      orders: [legacyOrderId],
    },
    {
      tableNumber: 2,
      capacity: 2,
      status: "vacant",
    },
  ]);
  await db.collection("orders").insertMany([
    { totalPrice: 10, orderStatus: "Pending", menuItems: [] },
    { totalPrice: 12, orderStatus: "Pending", menuItems: [], clientOrderId: null },
  ]);

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

  const clientOrderIndex = (await db.collection("orders").indexes()).find(
    (index) => index.name === "restaurantId_1_clientOrderId_1"
  );
  assert.equal(clientOrderIndex.unique, true);
  assert.deepEqual(clientOrderIndex.partialFilterExpression, {
    clientOrderId: { $type: "string" },
  });

  const tables = await db.collection("tables").find({ restaurantId: first._id }).toArray();
  assert.equal(tables.length, 2);
  assert.equal(new Set(tables.map((item) => item.qrCode)).size, 2);
  for (const item of tables) {
    assert.equal(typeof item.qrCode, "string");
    assert.ok(item.qrCode.length >= 8);
  }

  await db.collection("orders").dropIndex("restaurantId_1_clientOrderId_1");
  const legacyOrders = await db.collection("orders").find({}).toArray();
  await db.collection("orders").bulkWrite(
    legacyOrders.map((order, index) => ({
      updateOne: {
        filter: { _id: order._id },
        update: { $set: { clientOrderId: `legacy-${index}` } },
      },
    }))
  );
  await db.collection("orders").createIndex(
    { restaurantId: 1, clientOrderId: 1 },
    { unique: true, name: "restaurantId_1_clientOrderId_1" }
  );
  await migrateTenants();
  const replaced = (await db.collection("orders").indexes()).find(
    (index) => index.name === "restaurantId_1_clientOrderId_1"
  );
  assert.deepEqual(replaced.partialFilterExpression, {
    clientOrderId: { $type: "string" },
  });

  const { default: Table } = await import("../../src/modules/tables/table.model.js");
  const other = await Restaurant.create({ name: "Other", slug: "other" });
  await MenuItem.create({
    restaurantId: other._id,
    title: "Pizza",
    description: "desc",
    price: 12,
    priceCents: 1200,
    image: "y.png",
    categoryId: new mongoose.Types.ObjectId(),
  });
  await Table.create({
    restaurantId: other._id,
    tableNumber: 1,
    capacity: 2,
  });
  assert.equal(await MenuItem.countDocuments({ title: "Pizza" }).setOptions({ skipTenant: true }), 2);
});

test("staff login migration refuses conflicting names, then swaps to per-restaurant indexes", async () => {
  const { migrateStaffLogins } = await import("../../src/db/migrateStaffLogins.js");
  const employees = mongoose.connection.db.collection("employees");
  await employees.deleteMany({});
  await employees.createIndex({ employee: 1 }, { unique: true, name: "employee_1" });
  await employees.createIndex({ email: 1 }, { unique: true, name: "email_1" });
  const barA = new mongoose.Types.ObjectId();
  const barB = new mongoose.Types.ObjectId();
  await employees.insertMany([
    { restaurantId: barA, employee: "PeterTest", email: "a@x.com", position: "bar", role: "staff" },
    { restaurantId: barA, employee: "PETERTEST ", email: "b@x.com", position: "bar", role: "staff" },
    { restaurantId: barA, employee: "Boss", email: "Owner@X.com", position: "owner", role: "owner" },
    { restaurantId: barB, employee: "Rope", email: "c@x.com", position: "bar", role: "staff" },
  ]);

  const refused = await migrateStaffLogins();
  assert.equal(refused.applied, false);
  assert.deepEqual(refused.conflicts, [
    { restaurantId: String(barA), name: "petertest", employees: ["PeterTest", "PETERTEST "] },
  ]);
  const untouched = (await employees.indexes()).map((index) => index.name);
  assert.ok(untouched.includes("employee_1"));

  await employees.updateOne({ employee: "PETERTEST " }, { $set: { employee: "Peter Bar" } });
  const applied = await migrateStaffLogins();
  assert.equal(applied.applied, true);
  const names = (await employees.indexes()).map((index) => index.name);
  assert.ok(!names.includes("employee_1"));
  assert.ok(!names.includes("email_1"));
  assert.ok(names.includes("restaurantId_1_employee_1"));
  assert.equal((await employees.findOne({ employee: "Boss" })).email, "owner@x.com");
  // Another restaurant may now hire a "Rope" of its own.
  await employees.insertOne({ restaurantId: barA, employee: "Rope", position: "bar", role: "staff" });
});

test("category migration gives every restaurant the defaults and links items to categories by name", async () => {
  const { migrateCategories } = await import("../../src/db/migrateCategories.js");
  const { default: Restaurant } = await import("../../src/modules/restaurants/restaurant.model.js");
  const { default: Category } = await import("../../src/modules/categories/category.model.js");
  const db = mongoose.connection.db;
  const place = await Restaurant.create({ name: "Categorized", slug: "categorized" });
  await Category.create({ restaurantId: place._id, name: "Specials", station: "kitchen", position: 1 });
  const items = db.collection("menuitems");
  await items.insertMany([
    { restaurantId: place._id, title: "Pizza Peperoni", category: "pizza", station: "kitchen", image: "" },
    { restaurantId: place._id, title: "Bier", category: "pizza", station: "kitchen" },
    { restaurantId: place._id, title: "Hausbier", category: "Hausbier ", station: "bar" },
    { restaurantId: place._id, title: "Soup of the day", category: "SPECIALS" },
  ]);

  // The pre-tenant index made a title unique across every restaurant.
  await items.createIndex({ title: 1 }, { name: "title_1" });

  const first = await migrateCategories();
  const second = await migrateCategories();
  const indexNames = (await items.indexes()).map((index) => index.name);
  assert.equal(indexNames.includes("title_1"), false);
  assert.equal(indexNames.includes("restaurantId_1_title_1"), true);
  assert.equal(second.linkedItems, 0);
  assert.ok(first.linkedItems >= 4);

  const categories = await Category.find({ restaurantId: place._id }).sort({ position: 1 }).lean();
  const names = categories.map((category) => category.name);
  assert.equal(names[0], "Specials");
  assert.ok(names.includes("Beer") && names.includes("Pizza") && names.includes("Hausbier"));
  assert.equal(names.length, 1 + 14 + 1);
  const idOf = (name) => String(categories.find((category) => category.name === name)._id);
  assert.equal(categories.find((category) => category.name === "Hausbier").station, "bar");

  const byTitle = async (title) => items.findOne({ restaurantId: place._id, title });
  assert.equal(String((await byTitle("Pizza Peperoni")).categoryId), idOf("Pizza"));
  // No guessing: Bier was filed under pizza and stays there until moved.
  assert.equal(String((await byTitle("Bier")).categoryId), idOf("Pizza"));
  assert.equal(String((await byTitle("Hausbier")).categoryId), idOf("Hausbier"));
  assert.equal(String((await byTitle("Soup of the day")).categoryId), idOf("Specials"));
  const migrated = await byTitle("Pizza Peperoni");
  assert.equal("category" in migrated, false);
  assert.equal("station" in migrated, false);
  assert.equal(migrated.image, null);
});

test("ticket migration gives old orders a ticket per station at the order's status", async () => {
  const { migrateTickets } = await import("../../src/db/migrateTickets.js");
  const orders = mongoose.connection.db.collection("orders");
  const restaurantId = new mongoose.Types.ObjectId();
  const line = (station) => ({ title: station, quantity: 1, lineTotalCents: 100, station });
  await orders.insertMany([
    { restaurantId, clientOrderId: "old-mixed", status: "preparing", items: [line("bar"), line("kitchen")] },
    { restaurantId, clientOrderId: "old-gone", status: "cancelled", cancelReason: "left", items: [line("bar")] },
    {
      restaurantId,
      clientOrderId: "new",
      status: "pending",
      items: [line("bar"), line("kitchen")],
      tickets: [
        { station: "kitchen", status: "pending", cancelReason: "" },
        { station: "bar", status: "served", cancelReason: "" },
      ],
    },
  ]);

  await migrateTickets();
  const second = await migrateTickets();
  assert.equal(second.ticketedOrders, 0);

  const ticketsOf = async (clientOrderId) => (await orders.findOne({ restaurantId, clientOrderId })).tickets;
  assert.deepEqual(await ticketsOf("old-mixed"), [
    { station: "kitchen", status: "preparing", cancelReason: "" },
    { station: "bar", status: "preparing", cancelReason: "" },
  ]);
  assert.deepEqual(await ticketsOf("old-gone"), [
    { station: "bar", status: "cancelled", cancelReason: "left" },
  ]);
  assert.equal((await ticketsOf("new"))[1].status, "served");
});

test("the sample menu fills a restaurant once and never touches its own items", async () => {
  const { seedSampleMenu } = await import("../../src/db/seedSampleMenu.js");
  const { SAMPLE_MENU } = await import("../../src/db/sampleMenu.js");
  const { default: Restaurant } = await import("../../src/modules/restaurants/restaurant.model.js");
  const { default: Category } = await import("../../src/modules/categories/category.model.js");
  const { default: MenuItem } = await import("../../src/modules/menu/menuItem.model.js");
  const place = await Restaurant.create({ name: "Sample", slug: "sample-place" });
  const mine = await Category.create({ restaurantId: place._id, name: "Pizza", station: "kitchen", position: 1 });
  await MenuItem.create({
    restaurantId: place._id,
    title: "pizza margherita",
    price: 7,
    priceCents: 700,
    categoryId: mine._id,
  });

  const first = await seedSampleMenu("SAMPLE-place");
  assert.equal(first.added, SAMPLE_MENU.length - 1);
  assert.equal(first.skipped, 1);
  const second = await seedSampleMenu("sample-place");
  assert.equal(second.added, 0);

  const own = await MenuItem.findOne({ restaurantId: place._id, title: "pizza margherita" });
  assert.equal(own.priceCents, 700);
  const lager = await MenuItem.findOne({ restaurantId: place._id, title: "Lager 0.5l" });
  const beer = await Category.findOne({ _id: lager.categoryId, restaurantId: place._id });
  assert.equal(beer.name, "Beer");
  assert.equal(beer.station, "bar");
  assert.equal(lager.priceCents, 490);
  assert.match(lager.image, /^https:\/\/images\.unsplash\.com\//);

  await assert.rejects(() => seedSampleMenu("no-such-place"), /No restaurant with slug/);
});
