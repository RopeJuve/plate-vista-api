import { z } from "zod";

const menuFields = {
  title: z.string().min(3, "Title must be at least 3 characters long"),
  description: z.string().min(1, "Description must be a string"),
  price: z.coerce.number().positive("Price must be a number"),
  image: z.string().min(1, "Image must be a string"),
  category: z.string().min(1, "Category must be a string"),
  station: z.enum(["kitchen", "bar"]).optional(),
  popular: z.boolean().optional(),
  inStock: z.boolean().optional(),
};

export const createMenuSchema = z.object({
  title: menuFields.title,
  description: menuFields.description,
  price: menuFields.price,
  image: menuFields.image,
  category: menuFields.category,
  station: menuFields.station,
  popular: menuFields.popular,
  inStock: menuFields.inStock,
});

export const updateMenuSchema = z.object(menuFields).partial();
