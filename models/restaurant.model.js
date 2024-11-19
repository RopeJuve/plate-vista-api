import { Schema, model } from "mongoose";

const restaurantSchema = new Schema({
  restaurantName: {
    type: String,
    required: true,
    unique: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  databaseUrl: {
    type: String,
    required: true,
    unique: true
  },
  active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

restaurantSchema.pre('save', function(next) {
  console.log('Attempting to save restaurant:', this);
  next();
});
const Restaurant = model("Restaurant", restaurantSchema);
export default Restaurant;