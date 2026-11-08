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
    // The seller's details a German receipt must show and TSE activation needs.
    // Optional here; legal.js decides when they are complete.
    legal: {
      legalName: { type: String, trim: true },
      address: {
        street: { type: String, trim: true },
        zip: { type: String, trim: true },
        city: { type: String, trim: true },
        country: { type: String, default: "DE" },
      },
      taxNumber: { type: String, trim: true },
      vatId: { type: String, trim: true },
    },
  },
  { timestamps: true }
);

restaurantSchema.pre("validate", function normalizeSlug() {
  if (this.slug) this.slug = String(this.slug).toLowerCase().trim();
});

const Restaurant = model("Restaurant", restaurantSchema);
export default Restaurant;
