
import dotenv from "dotenv";
dotenv.config();
import { dbManager } from "../utils/dbManager.js";

const connectToDatabase = async () => {
  try {
    const mainDbUrl = `${process.env.MONGO_DB_URL}/${process.env.MONGO_DB_OPTIONS}`;
    await dbManager.connectToMain(mainDbUrl);
    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("Error connecting to MongoDB", err);
    process.exit(1);
  }
};

export default connectToDatabase;
