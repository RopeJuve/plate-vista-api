import { z } from "zod";

const name = z
  .string({ error: "Name is required" })
  .trim()
  .min(1, "Name is required")
  .max(40, "Name must be at most 40 characters");

export const addCardReaderSchema = z.object({
  registrationCode: z.string({ error: "Registration code is required" }).trim().min(1, "Registration code is required"),
  name,
});

export const addSimulatedReaderSchema = z.object({ name });
