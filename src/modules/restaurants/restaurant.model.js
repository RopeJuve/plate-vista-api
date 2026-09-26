import { Schema, model } from "mongoose";

const restaurantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    settings: {
      currency: { type: String, default: "EUR" },
      timezone: { type: String, default: "Europe/Berlin" },
    },
  },
  { timestamps: true }
);

restaurantSchema.pre("validate", function normalizeSlug() {
  if (this.slug) this.slug = String(this.slug).toLowerCase().trim();
});

const Restaurant = model("Restaurant", restaurantSchema);
export default Restaurant;
