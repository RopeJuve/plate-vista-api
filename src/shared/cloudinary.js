import { createHash } from "node:crypto";
import { AppError } from "./errors.js";

// Browsers upload images straight to Cloudinary; the API only signs the
// upload, so files never pass through (or count against) our request limits
// and the API secret never leaves the server.
// https://cloudinary.com/documentation/authentication_signatures

const credentials = () => {
  const {
    CLOUDINARY_CLOUD_NAME: cloudName,
    CLOUDINARY_API_KEY: apiKey,
    CLOUDINARY_API_SECRET: apiSecret,
  } = process.env;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new AppError("INTERNAL", "Image uploads are not configured", 503);
  }
  return { cloudName, apiKey, apiSecret };
};

// Cloudinary signs the request's parameters sorted by name, joined as a query
// string, with the API secret appended.
const sign = (params, apiSecret) =>
  createHash("sha1")
    .update(
      Object.keys(params)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join("&") + apiSecret
    )
    .digest("hex");

// One folder per restaurant, so its images can be found and cleaned up later.
const menuFolder = (restaurantId) => `plate-vista/${restaurantId}/menu`;
export const logoFolder = (restaurantId) => `plate-vista/${restaurantId}/logo`;

export const LOGO_FORMATS = ["jpg", "png", "webp"];
// Cloudinary cannot enforce a size in a signed upload; the browser checks it.
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const signMenuImageUpload = (restaurantId, now = Date.now()) => {
  const { cloudName, apiKey, apiSecret } = credentials();
  const folder = menuFolder(restaurantId);
  const timestamp = Math.floor(now / 1000);
  return { cloudName, apiKey, folder, timestamp, signature: sign({ folder, timestamp }, apiSecret) };
};

// No SVG: an SVG can carry script.
export const signLogoUpload = (restaurantId, now = Date.now()) => {
  const { cloudName, apiKey, apiSecret } = credentials();
  const folder = logoFolder(restaurantId);
  const timestamp = Math.floor(now / 1000);
  const allowedFormats = LOGO_FORMATS.join(",");
  const signature = sign({ allowed_formats: allowedFormats, folder, timestamp }, apiSecret);
  return { cloudName, apiKey, folder, timestamp, allowedFormats, maxBytes: LOGO_MAX_BYTES, signature };
};

// .../image/upload/v1712/plate-vista/abc/logo/x1.webp -> plate-vista/abc/logo/x1
export const publicIdFromUrl = (url) => {
  const match = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(?:v\d+\/)?(.+)\.[a-z0-9]+$/i.exec(
    String(url || "")
  );
  return match ? match[1] : null;
};

// Deletes one uploaded image. Resolves to false when there is nothing to do.
export const destroyImage = async (url, { fetch: doFetch = globalThis.fetch, now = Date.now() } = {}) => {
  const publicId = publicIdFromUrl(url);
  if (!publicId) return false;
  const { cloudName, apiKey, apiSecret } = credentials();
  const timestamp = Math.floor(now / 1000);
  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: apiKey,
    signature: sign({ public_id: publicId, timestamp }, apiSecret),
  });
  const res = await doFetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
    method: "POST",
    body,
  });
  if (!res.ok) throw new Error(`Cloudinary destroy failed with ${res.status}`);
  return true;
};
