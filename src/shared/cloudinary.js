import { createHash } from "node:crypto";
import { AppError } from "./errors.js";

// Browsers upload menu images straight to Cloudinary; the API only signs the
// upload, so files never pass through (or count against) our request limits
// and the API secret never leaves the server.
// https://cloudinary.com/documentation/authentication_signatures
export const signMenuImageUpload = (restaurantId, now = Date.now()) => {
  const {
    CLOUDINARY_CLOUD_NAME: cloudName,
    CLOUDINARY_API_KEY: apiKey,
    CLOUDINARY_API_SECRET: apiSecret,
  } = process.env;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new AppError("INTERNAL", "Image uploads are not configured", 503);
  }
  // One folder per restaurant, so its images can be found and cleaned up later.
  const folder = `plate-vista/${restaurantId}/menu`;
  const timestamp = Math.floor(now / 1000);
  const signature = createHash("sha1")
    .update(`folder=${folder}&timestamp=${timestamp}${apiSecret}`)
    .digest("hex");
  return { cloudName, apiKey, folder, timestamp, signature };
};
