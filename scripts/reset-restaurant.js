// Empties one restaurant and gives it a Restaurant document, so a seed script
// can fill it later. Legacy data (from before tenants) has a restaurantId but
// no Restaurant, which leaves its staff unable to log in by slug.
//
// Usage: node scripts/reset-restaurant.js --id <restaurantId> --name "Test Restaurant" --slug test-restaurant [--confirm]
// Without --confirm it only prints what it would delete. With it, every
// document is first written to backups/<id>-<time>/<collection>.json.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import "../src/config/load-dotenv.js";
import { connectToDatabase, disconnectDatabase } from "../src/db/db.js";

const COLLECTIONS = ["orders", "tablesessions", "tables", "menuitems", "employees"];

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const id = arg("id");
const name = arg("name") || "Test Restaurant";
const slug = arg("slug") || "test-restaurant";
const confirm = process.argv.includes("--confirm");
if (!id || !mongoose.Types.ObjectId.isValid(id)) {
  console.error("--id <restaurantId> is required");
  process.exit(1);
}

try {
  await connectToDatabase();
  const db = mongoose.connection.db;
  const restaurantId = new mongoose.Types.ObjectId(id);
  const filter = { restaurantId };

  const employeeIds = await db.collection("employees").distinct("_id", filter);
  const tokenFilter = { subjectType: "employee", subjectId: { $in: employeeIds } };
  const counts = {};
  for (const name of COLLECTIONS) counts[name] = await db.collection(name).countDocuments(filter);
  counts.refreshtokens = await db.collection("refreshtokens").countDocuments(tokenFilter);
  const existing = await db.collection("restaurants").findOne({ _id: restaurantId });
  const slugOwner = await db.collection("restaurants").findOne({ slug, _id: { $ne: restaurantId } });
  console.log({ restaurantId: id, existingRestaurant: existing?.slug || null, willDelete: counts });
  if (slugOwner) throw new Error(`slug "${slug}" already belongs to restaurant ${slugOwner._id}`);
  if (!confirm) {
    console.log("Dry run. Re-run with --confirm to back up, delete, and create the restaurant.");
    process.exit(0);
  }

  const dir = path.join("backups", `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(dir, { recursive: true });
  const backup = async (collection, query) => {
    const docs = await db.collection(collection).find(query).toArray();
    await writeFile(path.join(dir, `${collection}.json`), JSON.stringify(docs, null, 2));
  };
  for (const collection of COLLECTIONS) await backup(collection, filter);
  await backup("refreshtokens", tokenFilter);
  if (existing) await writeFile(path.join(dir, "restaurant.json"), JSON.stringify(existing, null, 2));
  console.log(`Backed up to ${dir}`);

  await db.collection("refreshtokens").deleteMany(tokenFilter);
  for (const collection of COLLECTIONS) await db.collection(collection).deleteMany(filter);
  const now = new Date();
  await db.collection("restaurants").updateOne(
    { _id: restaurantId },
    {
      $set: { name, slug, status: "active", updatedAt: now },
      $setOnInsert: { settings: { currency: "EUR", timezone: "Europe/Berlin" }, createdAt: now },
    },
    { upsert: true }
  );
  console.log(`Restaurant ${id} is now "${name}" (${slug}) and empty.`);
  await disconnectDatabase();
} catch (error) {
  console.error(error);
  process.exit(1);
}
