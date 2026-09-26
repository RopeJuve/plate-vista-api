import { Schema, model } from "mongoose";
import { nanoid } from "nanoid";
import { tenantPlugin } from "../../shared/tenantPlugin.js";

const tableSchema = new Schema(
  {
    restaurantId: {
      type: Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
      index: true,
    },
    tableNumber: { type: Number, required: true },
    capacity: { type: Number, required: true },
    status: {
      type: String,
      enum: ["occupied", "vacant", "reserved"],
      default: "vacant",
    },
    qrCode: { type: String, required: true, unique: true, default: () => nanoid(12) },
  },
  { timestamps: true }
);

tableSchema.index({ restaurantId: 1, tableNumber: 1 }, { unique: true });
tableSchema.plugin(tenantPlugin);

const Table = model("Table", tableSchema);
export default Table;
