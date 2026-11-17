import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";

const sessionSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    tableId: { type: Schema.Types.ObjectId, ref: "Table", required: true },
    status: {
      type: String,
      enum: ["open", "paying", "closed"],
      default: "open",
    },
    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date },
    lastOrderAt: { type: Date },
    code: { type: String, required: true },
    // Set when an owner or admin closed the table with its bill unpaid.
    unpaidCloseReason: { type: String },
    unpaidClosedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    // The online payment a guest started, while the session is `paying`.
    // `attemptId` names this start, so Stripe sees a retry of the same start
    // as the same request; Stripe's id and url arrive after the freeze.
    onlinePayment: {
      type: new Schema(
        {
          attemptId: { type: String, required: true },
          checkoutSessionId: { type: String },
          url: { type: String },
          amountCents: { type: Number, required: true },
          expiresAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: undefined,
    },
  },
  { timestamps: true }
);

sessionSchema.index(
  { tableId: 1 },
  { unique: true, partialFilterExpression: { status: "open" } }
);

sessionSchema.plugin(tenantPlugin);

const TableSession = model("TableSession", sessionSchema);
export default TableSession;
