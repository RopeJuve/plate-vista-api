import mongoose from "mongoose";

// Menu items once kept a float price next to priceCents; priceCents is now
// the only price. Items without priceCents get it from the float price, then
// the float price is removed from every item. Safe to run again: items
// without a price are left alone. A dry run only counts what it would change.
export const migrateDropMenuPrice = async ({ dryRun = false } = {}) => {
  const items = mongoose.connection.db.collection("menuitems");
  const legacy = await items.find({ price: { $exists: true } }).toArray();
  const missingCents = legacy.filter((item) => item.priceCents == null);
  if (!dryRun && legacy.length > 0) {
    await items.bulkWrite(
      legacy.map((item) => ({
        updateOne: {
          filter: { _id: item._id, price: { $exists: true } },
          update: {
            ...(item.priceCents == null && { $set: { priceCents: Math.round(item.price * 100) } }),
            $unset: { price: "" },
          },
        },
      }))
    );
  }
  return { dryRun, converted: missingCents.length, unset: legacy.length };
};
