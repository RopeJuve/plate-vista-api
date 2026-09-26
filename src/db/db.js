import mongoose from "mongoose";

// Filters are built in services, never by spreading request objects, so
// query operators like $in and $ne stay intact.
mongoose.set("sanitizeFilter", false);

const globalCache = globalThis;
if (!globalCache.__plateVistaMongoose) {
  globalCache.__plateVistaMongoose = { conn: null, promise: null };
}
const cached = globalCache.__plateVistaMongoose;

export const connectToDatabase = async () => {
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }
  if (!cached.promise) {
    const url = process.env.MONGO_DB_URL;
    if (!url) {
      throw new Error("MONGO_DB_URL is not set");
    }
    cached.promise = mongoose
      .connect(url, { serverSelectionTimeoutMS: 10000 })
      .then((mongooseInstance) => {
        cached.conn = mongooseInstance.connection;
        return cached.conn;
      })
      .catch((error) => {
        cached.promise = null;
        cached.conn = null;
        throw error;
      });
  }
  return cached.promise;
};

export const disconnectDatabase = async () => {
  cached.promise = null;
  cached.conn = null;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
};
