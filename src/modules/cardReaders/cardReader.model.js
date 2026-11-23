import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";

// A Card Reader (GLOSSARY.md): a Stripe smart reader registered to the
// restaurant's Payout Account (ADR-0008). Stripe's ids stay here and never
// leave the API.
const cardReaderSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true },
    stripeAccountId: { type: String, required: true },
    stripeReaderId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    deviceType: { type: String, required: true },
    serialNumber: { type: String },
    simulated: { type: Boolean, default: false },
    // As Stripe last reported it; shown when Stripe cannot be read.
    status: { type: String, enum: ["online", "offline"], default: "offline" },
  },
  { timestamps: true }
);

cardReaderSchema.index({ stripeReaderId: 1 }, { unique: true });
cardReaderSchema.plugin(tenantPlugin);

const CardReader = model("CardReader", cardReaderSchema);
export default CardReader;
