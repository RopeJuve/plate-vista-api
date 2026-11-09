import { randomBytes } from "node:crypto";
import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";

export const PAYMENT_METHODS = ["CASH", "CARD_TERMINAL", "ONLINE"];
export const SIGNATURE_STATUSES = ["PENDING", "SIGNED", "FAILED"];

export const newReceiptToken = () => randomBytes(16).toString("hex");

// The TSE's Kassenbeleg transaction for this payment (ADR-0003). It is signed
// after the reply (ADR-0005), so a payment starts PENDING.
const tseSchema = new Schema(
  {
    status: { type: String, enum: SIGNATURE_STATUSES, default: "PENDING" },
    txId: { type: String },
    revision: { type: Number },
    txNumber: { type: Number },
    timeStart: { type: Date },
    timeEnd: { type: Date },
    signatureValue: { type: String },
    signatureCounter: { type: Number },
    tssSerial: { type: String },
    clientSerial: { type: String },
    qrCodeData: { type: String },
    lastError: { type: String },
    retryCount: { type: Number, default: 0 },
    nextAttemptAt: { type: Date },
  },
  { _id: false }
);

const paymentSchema = new Schema(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: "TableSession", required: true },
    tableId: { type: Schema.Types.ObjectId, ref: "Table", required: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    amountCents: { type: Number, required: true, min: 1 },
    paidAt: { type: Date, required: true },
    paidBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    clientPaymentId: { type: String, required: true },
    receiptToken: { type: String, required: true, default: newReceiptToken },
    tse: { type: tseSchema, default: () => ({}) },
  },
  { timestamps: true }
);

// One payment per bill for now: the index is what makes a second, concurrent
// payment fail.
paymentSchema.index({ restaurantId: 1, sessionId: 1 }, { unique: true });
paymentSchema.index({ receiptToken: 1 }, { unique: true });
paymentSchema.index({ restaurantId: 1, clientPaymentId: 1 }, { unique: true });
paymentSchema.index({ restaurantId: 1, "tse.status": 1 });

paymentSchema.plugin(tenantPlugin);

const Payment = model("Payment", paymentSchema);
export default Payment;
