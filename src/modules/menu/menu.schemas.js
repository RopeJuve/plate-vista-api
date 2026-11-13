import mongoose from "mongoose";
import { z } from "zod";

const objectId = (message) =>
  z.string({ error: message }).refine((value) => mongoose.Types.ObjectId.isValid(value), message);

const menuFields = {
  title: z.string().trim().min(3, "Title must be at least 3 characters long"),
  description: z.string().trim().max(500, "Description is too long"),
  priceCents: z
    .number({ error: "Price must be a whole number of cents" })
    .int("Price must be a whole number of cents")
    .positive("Price must be more than 0"),
  // An uploaded (Cloudinary) or pasted link; null removes the image.
  image: z
    .string()
    .trim()
    .url("Image must be a link")
    .startsWith("https://", "Image link must start with https://")
    .nullable(),
  categoryId: objectId("Category is required"),
  popular: z.boolean(),
  inStock: z.boolean(),
};

// The float price is gone; a client still sending it is told so instead of
// having it silently dropped.
const noLegacyPrice = {
  price: z.undefined({ error: "Send priceCents, not price" }).optional(),
};

export const createMenuSchema = z.object({
  ...noLegacyPrice,
  title: menuFields.title,
  description: menuFields.description.optional(),
  priceCents: menuFields.priceCents,
  image: menuFields.image.optional(),
  categoryId: menuFields.categoryId,
  popular: menuFields.popular.optional(),
  inStock: menuFields.inStock.optional(),
});

export const updateMenuSchema = z.object(menuFields).partial().extend(noLegacyPrice);
