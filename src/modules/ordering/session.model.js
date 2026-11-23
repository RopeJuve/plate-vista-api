import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../shared/tenantPlugin.js";

// The kinds of payment a bill can be frozen for.
export const PAYMENT_IN_PROGRESS_KINDS = ["online", "card_reader"];

// One attempt to take the bill's payment; see paymentInProgress below.
const attemptFields = {
  kind: { type: String, enum: PAYMENT_IN_PROGRESS_KINDS, required: true },
  attemptId: { type: String, required: true },
  checkoutSessionId: { type: String },
  url: { type: String },
  cardReaderPaymentId: { type: Schema.Types.ObjectId },
  readerId: { type: Schema.Types.ObjectId, ref: "CardReader" },
  readerName: { type: String },
  readerSimulated: { type: Boolean },
  stripeReaderId: { type: String },
  paymentIntentId: { type: String },
  // A retry's earlier PaymentIntent, used again while Stripe still can.
  reusablePaymentIntentId: { type: String },
  retry: { type: Boolean },
  collecting: { type: Boolean },
  amountCents: { type: Number, required: true },
  startedAt: { type: Date },
  expiresAt: { type: Date, required: true },
};

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
    // and url arrive after the freeze. For `card_reader`, the reader it was
    // sent to (with its name as it was then), our id for the attempt (the
    // contract's CardReaderPayment id), and Stripe's PaymentIntent id, which
    // arrives after the freeze; `collecting` once the reader was told. A
    // retry keeps the CardReaderPayment id and gets a new attemptId.
    paymentInProgress: {
      type: new Schema(attemptFields, { _id: false }),
      default: undefined,
    },
    // The last card reader attempt that failed (declined, or the reader
    // failed), kept on the open bill with why, so staff can see it and
    // retry. A retry or a new start takes its place.
    failedCardReaderPayment: {
      type: new Schema(
        {
          ...attemptFields,
          failure: {
            reason: { type: String, required: true },
            message: { type: String, required: true },
          },
          failedAt: { type: Date, required: true },
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
