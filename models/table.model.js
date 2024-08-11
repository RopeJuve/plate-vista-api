import { Schema, model } from "mongoose";

const tableSchema = new Schema(
  {
    tableNumber: {
      type: Number,
      required: true,
      unique: true,
    },
    capacity: {
      type: Number,
      required: true,
    },
    isOccupied: {
      type: Boolean,
      default: false,
    },
    orders: [
      {
        type: Schema.Types.ObjectId,
        ref: "Order",
      },
    ],
    customers: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  {
    timestamps: true,
  }
);

const Table = model("Table", tableSchema);

export default Table;
