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
    code: { type: String, required: true },
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
