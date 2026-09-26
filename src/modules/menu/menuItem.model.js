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
    description: { type: String, required: true },
    price: { type: Number, required: true },
    priceCents: { type: Number, required: true },
    image: { type: String, required: true },
    category: { type: String, required: true },
    station: { type: String, enum: ["kitchen", "bar"], default: "kitchen" },
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
