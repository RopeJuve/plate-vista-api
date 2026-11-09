import { z } from "zod";

export const recordPaymentSchema = z.object({
  method: z.enum(["CASH", "CARD_TERMINAL"], { error: "method must be CASH or CARD_TERMINAL" }),
  clientPaymentId: z
    .string({ error: "clientPaymentId is required" })
    .trim()
    .min(1, "clientPaymentId is required")
    .max(100, "clientPaymentId must be at most 100 characters"),
  expectedTotalCents: z
    .number({ error: "expectedTotalCents must be a whole number of cents" })
    .int("expectedTotalCents must be a whole number of cents")
    .min(0, "expectedTotalCents must be >= 0"),
});

export const closeSessionSchema = z.object({
  unpaidReason: z
    .string()
    .trim()
    .min(1, "unpaidReason must not be empty")
    .max(500, "unpaidReason must be at most 500 characters")
    .optional(),
});
