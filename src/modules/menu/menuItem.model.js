import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";

const menuItemSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    price: { type: Number, required: true },
    priceCents: { type: Number, required: true },
    // No image means guests see the placeholder for the item's station.
    image: { type: String, default: null },
    // The category also decides the station (docs/adr/0001-station-belongs-to-category.md).
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    popular: { type: Boolean, default: false },
    numSold: { type: Number, default: 0 },
    inStock: { type: Boolean, default: true },
    archived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

menuItemSchema.index({ restaurantId: 1, title: 1 }, { unique: true });
menuItemSchema.plugin(tenantPlugin);

const MenuItem = model("MenuItem", menuItemSchema);
export default MenuItem;
