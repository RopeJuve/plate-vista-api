import mongoose from "mongoose";
import Restaurant from "../modules/restaurants/restaurant.model.js";
import Category from "../modules/categories/category.model.js";
import MenuItem from "../modules/menu/menuItem.model.js";
import { ensureDefaultCategories } from "../modules/categories/category.service.js";

const key = (name) => String(name || "").trim().toLowerCase();

// Moves menu items from a free-text category (and their own station) to a
// Category record. Every restaurant gets the default categories; an item's old
// text is matched to a category by name, ignoring case, and any name with no
// match becomes a new category with the item's old station. Items are never
// re-sorted by guessing ("Bier" filed under pizza stays in Pizza). Safe to run
// again: items that already have a category are left alone.
export const migrateCategories = async () => {
  const items = mongoose.connection.db.collection("menuitems");
  let addedDefaults = 0;
  let createdCategories = 0;
  let linkedItems = 0;

  for (const restaurant of await Restaurant.find({}).lean()) {
    const restaurantId = restaurant._id;
    addedDefaults += await ensureDefaultCategories(restaurantId);
    const byName = new Map(
      (await Category.find({ restaurantId }).lean()).map((category) => [key(category.name), category])
    );
    let position = Math.max(0, ...[...byName.values()].map((category) => category.position));

    const unlinked = await items
      .find({ restaurantId, categoryId: { $exists: false } })
      .toArray();
    for (const item of unlinked) {
      const name = String(item.category || "").trim() || "Other";
      let category = byName.get(key(name));
      if (!category) {
        category = await Category.create({
          restaurantId,
          name,
          station: item.station === "bar" ? "bar" : "kitchen",
          position: (position += 1),
        });
        byName.set(key(name), category);
        createdCategories += 1;
      }
      await items.updateOne(
        { _id: item._id },
        {
          $set: { categoryId: category._id, image: item.image || null },
          $unset: { category: "", station: "" },
        }
      );
      linkedItems += 1;
    }
  }

  // The pre-tenant "title_1" index made a title unique across every
  // restaurant; titles are unique per restaurant (restaurantId_1_title_1).
  const menuIndexes = await items.indexes();
  if (menuIndexes.some((index) => index.name === "title_1")) await items.dropIndex("title_1");
  await MenuItem.createIndexes();

  await Category.syncIndexes();
  return { addedDefaults, createdCategories, linkedItems };
};
