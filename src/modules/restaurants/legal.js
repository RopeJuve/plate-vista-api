import Restaurant from "./restaurant.model.js";
import { AppError } from "../../shared/errors.js";
import { parseOrThrow } from "../../shared/validate.js";
import { legalDetailsSchema } from "./restaurant.schemas.js";

const plain = (value) => (typeof value?.toObject === "function" ? value.toObject() : value);

export const serializeLegalDetails = (restaurant) => {
  const legal = plain(restaurant?.legal) || {};
  const address = legal.address || {};
  return {
    legalName: legal.legalName || null,
    address: {
      street: address.street || null,
      zip: address.zip || null,
      city: address.city || null,
      country: address.country || "DE",
    },
    taxNumber: legal.taxNumber || null,
    vatId: legal.vatId || null,
  };
};

// True when the restaurant has everything a receipt and TSE activation need.
export const hasCompleteLegalDetails = (restaurant) =>
  legalDetailsSchema.safeParse(serializeLegalDetails(restaurant)).success;

const notFound = () => new AppError("NOT_FOUND", "Restaurant not found");

export const getLegalDetails = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("legal").lean();
  if (!restaurant) throw notFound();
  return serializeLegalDetails(restaurant);
};

export const updateLegalDetails = async (restaurantId, input) => {
  const legal = parseOrThrow(legalDetailsSchema, input || {});
  const restaurant = await Restaurant.findByIdAndUpdate(
    restaurantId,
    { $set: { legal } },
    { new: true, runValidators: true }
  )
    .select("legal")
    .lean();
  if (!restaurant) throw notFound();
  return serializeLegalDetails(restaurant);
};
