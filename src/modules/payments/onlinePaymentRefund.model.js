import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";

export const LATE_PAYMENT_REASONS = ["BILL_ALREADY_PAID", "BILL_NOT_FROZEN", "SESSION_CLOSED"];

// A Late Payment (GLOSSARY.md) that was refunded in full. It is never a
// Payment. One per Checkout Session, so a redelivered event refunds once.
const onlinePaymentRefundSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: "TableSession", required: true },
    tableId: { type: Schema.Types.ObjectId, ref: "Table", required: true },
    // Kept here so the list still shows it after the table is renumbered.
    tableNumber: { type: Number },
    checkoutSessionId: { type: String, required: true },
    paymentIntentId: { type: String, required: true },
    amountCents: { type: Number, required: true },
    reason: { type: String, enum: LATE_PAYMENT_REASONS, required: true },
    refundedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

onlinePaymentRefundSchema.index({ checkoutSessionId: 1 }, { unique: true });
onlinePaymentRefundSchema.index({ restaurantId: 1, refundedAt: -1 });

onlinePaymentRefundSchema.plugin(tenantPlugin);

const OnlinePaymentRefund = model("OnlinePaymentRefund", onlinePaymentRefundSchema);
export default OnlinePaymentRefund;
