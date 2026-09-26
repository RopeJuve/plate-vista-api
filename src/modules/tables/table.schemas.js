import { z } from "zod";

const statuses = z.enum(["occupied", "vacant", "reserved"]);

export const createTableSchema = z.object({
  tableNumber: z.coerce.number().int().positive("Table number must be a number"),
  capacity: z.coerce.number().int().positive("Capacity must be a number"),
  status: statuses.optional(),
});

export const updateTableSchema = createTableSchema.partial();
