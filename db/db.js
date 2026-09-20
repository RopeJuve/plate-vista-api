import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

mongoose.set("sanitizeFilter", true);

const connectToDatabase = async () => {
  try {
    await mongoose.connect(process.env.MONGO_DB_URL);
    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("Error connecting to MongoDB", err);
    process.exit(1);
  }
};

export default connectToDatabase;
