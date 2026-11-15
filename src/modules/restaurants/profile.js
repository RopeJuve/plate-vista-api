// The Restaurant Profile: what guests see about a restaurant (logo, address,
// opening hours). Kept apart from the legal details, which a receipt needs;
// a profile without its own address shows the legal one.
import Restaurant from "./restaurant.model.js";
import { AppError } from "../../shared/errors.js";
import { parseOrThrow } from "../../shared/validate.js";
import { logger } from "../../shared/logger.js";
import { destroyImage, LOGO_FORMATS, logoFolder } from "../../shared/cloudinary.js";
import { profileSchema, WEEKDAYS } from "./profile.schemas.js";

const plain = (value) => (typeof value?.toObject === "function" ? value.toObject() : value);

const DEFAULT_TIMEZONE = "Europe/Berlin";

const addressOf = (source) =>
  source?.street && source?.zip && source?.city
    ? { street: source.street, zip: source.zip, city: source.city }
    : null;

const hoursOf = (stored) =>
  Object.fromEntries(
    WEEKDAYS.map((day) => [day, (stored?.[day] || []).map(({ open, close }) => ({ open, close }))])
  );

// What the dashboard edits.
export const serializeProfile = (restaurant) => {
  const profile = plain(restaurant?.profile) || {};
  const address = addressOf(profile.address);
  return {
    logoUrl: profile.logoUrl || null,
    address,
    usesLegalAddress: !address,
    legalAddress: addressOf(plain(restaurant?.legal)?.address),
    openingHours: hoursOf(profile.openingHours),
  };
};

// What guests see. Only these fields: never the legal name or tax IDs.
export const serializePublicProfile = (restaurant) => {
  const profile = serializeProfile(restaurant);
  return {
    name: restaurant?.name,
    logoUrl: profile.logoUrl,
    address: profile.address || profile.legalAddress,
    openingHours: profile.openingHours,
    timezone: restaurant?.settings?.timezone || DEFAULT_TIMEZONE,
  };
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Only images the browser uploaded with this restaurant's logo signature.
export const isOwnLogoUrl = (url, { cloudName, restaurantId }) => {
  if (typeof url !== "string" || !cloudName || !restaurantId) return false;
  const pattern = new RegExp(
    `^https://res\\.cloudinary\\.com/${escapeRegExp(cloudName)}/image/upload/(?:v\\d+/)?` +
      `${escapeRegExp(logoFolder(restaurantId))}/[^/]+\\.(?:${LOGO_FORMATS.join("|")}|jpeg)$`,
    "i"
  );
  return pattern.test(url);
};

let destroyer = destroyImage;
// For tests: replace (or with null, restore) how old logos are deleted.
export const setImageDestroyer = (fn) => {
  destroyer = fn || destroyImage;
};

const notFound = () => new AppError("NOT_FOUND", "Restaurant not found");

export const getProfile = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("profile legal").lean();
  if (!restaurant) throw notFound();
  return serializeProfile(restaurant);
};

export const updateProfile = async (restaurantId, input) => {
  const profile = parseOrThrow(profileSchema, input || {});
  if (
    profile.logoUrl &&
    !isOwnLogoUrl(profile.logoUrl, { cloudName: process.env.CLOUDINARY_CLOUD_NAME, restaurantId: String(restaurantId) })
  ) {
    throw new AppError("VALIDATION", "Upload the logo here", 400, {
      fields: { logoUrl: "Upload the logo here" },
    });
  }
  const before = await Restaurant.findByIdAndUpdate(
    restaurantId,
    { $set: { profile } },
    { new: false, runValidators: true }
  )
    .select("profile.logoUrl")
    .lean();
  if (!before) throw notFound();

  const oldLogo = before.profile?.logoUrl;
  if (oldLogo && oldLogo !== profile.logoUrl) {
    // Best effort: a leftover image costs storage, a failed save costs the owner.
    try {
      await destroyer(oldLogo);
    } catch (err) {
      logger.warn({ err, restaurantId: String(restaurantId) }, "could not delete the old logo");
    }
  }
  return getProfile(restaurantId);
};

export const getPublicProfile = async (slug) => {
  const restaurant = await Restaurant.findOne({ slug: String(slug).toLowerCase(), status: "active" })
    .select("name settings profile legal.address")
    .lean();
  if (!restaurant) throw new AppError("NOT_FOUND", "Not found", 404);
  return serializePublicProfile(restaurant);
};
