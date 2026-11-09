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
    // The restaurant's TSE at fiskaly. tse.service.js fills it in step by step
    // (setupStep is the last step that finished) so a failed setup resumes.
    // The admin PIN and PUK are encrypted (shared/crypto.js) and never selected
    // unless asked for.
    tse: {
      tssId: { type: String },
      clientId: { type: String },
      tssSerial: { type: String },
      clientSerial: { type: String },
      adminPinEnc: { type: String, select: false },
      adminPukEnc: { type: String, select: false },
      setupStep: {
        type: String,
        enum: [
          "TSS_PENDING",
          "TSS_CREATED",
          "UNINITIALIZED",
          "PIN_SET",
          "INITIALIZED",
          "CLIENT_PENDING",
          "CLIENT_CREATED",
          "DONE",
        ],
      },
      setupAt: { type: Date },
    },
  },
  { timestamps: true }
);

restaurantSchema.pre("validate", function normalizeSlug() {
  if (this.slug) this.slug = String(this.slug).toLowerCase().trim();
});

const Restaurant = model("Restaurant", restaurantSchema);
export default Restaurant;
