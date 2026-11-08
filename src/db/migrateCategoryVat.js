import mongoose from "mongoose";
import { defaultVatRate } from "../modules/categories/category.model.js";

// Gives every category saved before categories had a VAT rate the usual rate
// for its station: bar 19 % (NORMAL), kitchen 7 % (REDUCED_1)
// (docs/adr/0004-vat-rate-belongs-to-category.md). The owner confirms them.
// Safe to run again: categories with a rate are left alone. A dry run only
// counts what it would change.
export const migrateCategoryVat = async ({ dryRun = false } = {}) => {
  const categories = mongoose.connection.db.collection("categories");
  const missing = await categories.find({ vatRate: { $exists: false } }).toArray();
  if (!dryRun && missing.length > 0) {
    await categories.bulkWrite(
      missing.map((category) => ({
        updateOne: {
          filter: { _id: category._id, vatRate: { $exists: false } },
          update: { $set: { vatRate: defaultVatRate(category.station) } },
        },
      }))
    );
  }
  return { dryRun, updated: missing.length };
};
