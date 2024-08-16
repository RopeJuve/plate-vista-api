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
    status: {
      type: String,
      enum: ["occupied", "vacant", "reserved"],
      default: "vacant",
    },
    orders: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "Order",
        },
      ],
      default: [],
    },
    customers: {
      type: [
        {
          type: Schema.Types.ObjectId,
          ref: "Customer",
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

const Table = model("Table", tableSchema);

export default Table;
