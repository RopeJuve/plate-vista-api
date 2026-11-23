import { Schema, model } from "mongoose";
import { WEEKDAYS } from "./profile.schemas.js";

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
    // The Restaurant Profile guests see; profile.js validates and reads it.
    // No address of its own means guests see the legal address.
    profile: {
      logoUrl: { type: String, trim: true },
      address: {
        type: new Schema(
          {
            street: { type: String, trim: true },
            zip: { type: String, trim: true },
            city: { type: String, trim: true },
          },
          { _id: false }
        ),
        default: null,
      },
      openingHours: {
        type: new Schema(
          Object.fromEntries(
            WEEKDAYS.map((day) => [
              day,
              [new Schema({ open: String, close: String }, { _id: false })],
            ])
          ),
          { _id: false }
        ),
        default: undefined,
      },
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
    // The restaurant's Payout Account at Stripe (ADR-0006), created by
    // payouts/payout.service.js; the webhook keeps the flags in step. The id
    // is for us only and never goes to guests.
    payoutAccount: {
      type: new Schema(
        {
          stripeAccountId: { type: String, required: true },
          chargesEnabled: { type: Boolean, default: false },
          detailsSubmitted: { type: Boolean, default: false },
          // The owner's switch; guests can pay online only while it is on.
          onlinePaymentsEnabled: { type: Boolean, default: true },
          // The Stripe Terminal Location the restaurant's card readers are
          // registered under, made from the legal address with the first
          // reader. A Stripe detail, never shown.
          terminalLocationId: { type: String },
        },
        { _id: false }
      ),
      default: undefined,
    },
  },
  { timestamps: true }
);

restaurantSchema.index(
  { "payoutAccount.stripeAccountId": 1 },
  { unique: true, partialFilterExpression: { "payoutAccount.stripeAccountId": { $type: "string" } } }
);

restaurantSchema.pre("validate", function normalizeSlug() {
  if (this.slug) this.slug = String(this.slug).toLowerCase().trim();
});

const Restaurant = model("Restaurant", restaurantSchema);
export default Restaurant;
