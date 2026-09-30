import currency from "currency.js";
import Restaurant from "../modules/restaurants/restaurant.model.js";
import Category, { CATEGORY_NAME_COLLATION } from "../modules/categories/category.model.js";
import MenuItem from "../modules/menu/menuItem.model.js";
import { ensureDefaultCategories } from "../modules/categories/category.service.js";
import { SAMPLE_MENU } from "./sampleMenu.js";

const key = (text) => String(text).trim().toLowerCase();

// Adds the sample menu to one restaurant, for development and demos. Only
// titles the restaurant does not have yet (ignoring case) are added; its own
// items and categories are never changed. Safe to run again.
export const seedSampleMenu = async (slug) => {
  const restaurant = await Restaurant.findOne({ slug: key(slug) }).lean();
  if (!restaurant) throw new Error(`No restaurant with slug "${slug}"`);
  const restaurantId = restaurant._id;

  await ensureDefaultCategories(restaurantId);
  const categories = await Category.find({ restaurantId }).collation(CATEGORY_NAME_COLLATION).lean();
  const categoryOf = new Map(categories.map((category) => [key(category.name), category]));
  const titles = new Set(
    (await MenuItem.find({ restaurantId }).select("title").lean()).map((item) => key(item.title))
  );

  const missing = SAMPLE_MENU.filter((item) => !titles.has(key(item.title)));
  // An owner may have deleted a default category; its sample items are skipped.
  const placeable = missing.filter((item) => categoryOf.has(key(item.category)));
  await MenuItem.insertMany(
    placeable.map((item) => ({
      restaurantId,
      title: item.title,
      description: item.description ?? "",
      price: currency(item.price).value,
      priceCents: currency(item.price).intValue,
      image: item.image,
      categoryId: categoryOf.get(key(item.category))._id,
      popular: Boolean(item.popular),
      inStock: true,
    }))
  );
  return { added: placeable.length, skipped: SAMPLE_MENU.length - placeable.length };
};
