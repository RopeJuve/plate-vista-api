import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";

// The kinds of payment a bill can be frozen for.
export const PAYMENT_IN_PROGRESS_KINDS = ["online"];

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
    // The payment in progress while the session is `paying` (the bill is
    // frozen, GLOSSARY.md): its `kind` and that attempt's data. `attemptId`
    // names this start, so the payment provider sees a retry of the same
    // start as the same request. For `online`, Stripe's Checkout Session id
    // and url arrive after the freeze.
    paymentInProgress: {
      type: new Schema(
        {
          kind: { type: String, enum: PAYMENT_IN_PROGRESS_KINDS, required: true },
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
