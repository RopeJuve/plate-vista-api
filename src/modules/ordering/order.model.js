import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";
import { ORDER_STATUSES } from "./order.transitions.js";
import { STATIONS, VAT_RATES } from "../categories/category.model.js";

const lineItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "MenuItem", required: true },
    title: { type: String, required: true },
    unitPriceCents: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    lineTotalCents: { type: Number, required: true },
    notes: { type: String, default: "" },
    status: { type: String, default: "pending" },
    station: { type: String, enum: ["kitchen", "bar"], default: "kitchen" },
    // Copied from the menu item like title and price, so stats keep the
    // category the dish had when it was sold.
    category: { type: String },
    // Copied from the category when the order is placed; orders placed before
    // categories had a rate have none.
    vatRate: {
      type: String,
      enum: VAT_RATES,
      required() {
        return this.ownerDocument().isNew;
      },
    },
  },
  { _id: false }
);

// One station's part of the order, with its own status
// (docs/adr/0002-one-order-with-a-ticket-per-station.md).
const ticketSchema = new Schema(
  {
    station: { type: String, enum: STATIONS, required: true },
    status: { type: String, enum: ORDER_STATUSES, default: "pending" },
    cancelReason: { type: String, default: "" },
  },
  { _id: false }
);

export const SIGNATURE_STATUSES = ["PENDING", "SIGNED", "FAILED"];

// One line of a Bestellung as the TSE recorded it; negative in a correction.
const signedLineSchema = new Schema(
  {
    text: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitPriceCents: { type: Number, required: true },
  },
  { _id: false }
);

// The TSE's Bestellung transaction for this order (ADR-0003). It is signed
// after the reply (ADR-0005), so it starts PENDING. Orders of a restaurant
// without an active TSE, and orders from before signing, have none.
const orderTseSchema = new Schema(
  {
    status: { type: String, enum: SIGNATURE_STATUSES, default: "PENDING" },
    txId: { type: String },
    revision: { type: Number },
    txNumber: { type: Number },
    signatureCounter: { type: Number },
    timeEnd: { type: Date },
    // What the Bestellung records, fixed when its transaction is started.
    lines: { type: [signedLineSchema], default: undefined },
    lastError: { type: String },
    retryCount: { type: Number, default: 0 },
    nextAttemptAt: { type: Date },
    // Set while one signer works on the order and its corrections.
    lockedUntil: { type: Date },
  },
  { _id: false }
);

// A change to a signed order (a cancelled ticket, an edit), signed as its own
// Bestellung with the difference.
const tseCorrectionSchema = new Schema({
  // The cancelled ticket's station; absent for an edit.
  station: { type: String, enum: STATIONS },
  status: { type: String, enum: SIGNATURE_STATUSES, default: "PENDING" },
  lines: { type: [signedLineSchema], default: undefined },
  txId: { type: String },
  txNumber: { type: Number },
  lastError: { type: String },
  retryCount: { type: Number, default: 0 },
  nextAttemptAt: { type: Date },
  // When the change was made; older corrections fall back to their _id's time.
  createdAt: { type: Date, default: Date.now },
});

const orderSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    tableId: { type: Schema.Types.ObjectId, ref: "Table", required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: "TableSession", required: true },
    clientOrderId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    items: { type: [lineItemSchema], required: true },
    tickets: { type: [ticketSchema], default: [] },
    totalCents: { type: Number, required: true },
    // The slowest ticket that is not cancelled; kept in step with the tickets.
    status: { type: String, enum: ORDER_STATUSES, default: "pending" },
    statusHistory: [
      {
        status: { type: String, required: true },
        at: { type: Date, required: true },
        byEmployeeId: { type: Schema.Types.ObjectId, ref: "Employee" },
        // The ticket that moved; absent when the whole order moved.
        station: { type: String, enum: STATIONS },
      },
    ],
    cancelReason: { type: String },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    rev: { type: Number, default: 1, min: 1 },
    tse: { type: orderTseSchema },
    tseCorrections: { type: [tseCorrectionSchema], default: undefined },
  },
  { timestamps: true }
);

orderSchema.index(
  { restaurantId: 1, clientOrderId: 1 },
  { unique: true, partialFilterExpression: { clientOrderId: { $type: "string" } } }
);
orderSchema.index({ restaurantId: 1, createdAt: -1 });
orderSchema.index({ restaurantId: 1, sessionId: 1 });
// The signing sweep looks across restaurants (src/jobs/tseSweep.js).
orderSchema.index({ "tse.status": 1, "tse.nextAttemptAt": 1 }, { sparse: true });
orderSchema.index({ "tseCorrections.status": 1 }, { sparse: true });
orderSchema.plugin(tenantPlugin);

// The orders that make up a session's bill: every one not fully cancelled.
orderSchema.statics.findOnBill = function findOnBill(restaurantId, sessionId) {
  return this.find({ restaurantId, sessionId, status: { $ne: "cancelled" } });
};

const Order = model("Order", orderSchema);
export default Order;
