import { Schema, model } from "mongoose";

const menuItemSchema = new Schema({
  title: {
    type: String,
    required: true,
    unique: true,
  },
  description: {
    type: String,
    required: true,
  },
  price: {
    type: Number,
    required: true,
  },
  image: {
    type: String,
    required: true,
  },
  category: {
    type: String,
    required: true,
  },
  popular: {
    type: Boolean,
    default: false,
  },
  numSold: {
    type: Number,
    default: 0,
  },
  inStock: {
    type: Boolean,
    default: true,
  },
});

const MenuItem = model("MenuItem", menuItemSchema);

export default MenuItem;
