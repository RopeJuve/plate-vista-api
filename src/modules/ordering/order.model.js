import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";
import { ORDER_STATUSES } from "./order.transitions.js";
import { STATIONS } from "../categories/category.model.js";

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
  },
  { timestamps: true }
);

orderSchema.index(
  { restaurantId: 1, clientOrderId: 1 },
  { unique: true, partialFilterExpression: { clientOrderId: { $type: "string" } } }
);
orderSchema.index({ restaurantId: 1, createdAt: -1 });
orderSchema.index({ restaurantId: 1, sessionId: 1 });
orderSchema.plugin(tenantPlugin);

const Order = model("Order", orderSchema);
export default Order;
