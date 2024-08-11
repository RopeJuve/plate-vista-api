import { Schema, model } from "mongoose";

const orderSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    menuItems: [
      {
        product: {
          type: Schema.Types.ObjectId,
          ref: "MenuItem",
          required: true,
        },
        quantity: {
          type: Number,
          required: true,
        },
      },
    ],
    orderStatus: {
      type: String,
      default: "Not Processed",
      enum: ["Not Processed", "Processing", "Completed"],
    },
  },
  {
    timestamps: true,
  }
);

const Order = model("Order", orderSchema);

export default Order;
