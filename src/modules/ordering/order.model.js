import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";
import { ORDER_STATUSES } from "./order.transitions.js";

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
    totalCents: { type: Number, required: true },
    status: { type: String, enum: ORDER_STATUSES, default: "pending" },
    statusHistory: [
      {
        status: { type: String, required: true },
        at: { type: Date, required: true },
        byEmployeeId: { type: Schema.Types.ObjectId, ref: "Employee" },
      },
    ],
    cancelReason: { type: String },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "Employee" },
  },
  { timestamps: true }
);

orderSchema.index({ restaurantId: 1, clientOrderId: 1 }, { unique: true });
orderSchema.index({ restaurantId: 1, createdAt: -1 });
orderSchema.index({ restaurantId: 1, sessionId: 1 });
orderSchema.plugin(tenantPlugin);

const Order = model("Order", orderSchema);
export default Order;
