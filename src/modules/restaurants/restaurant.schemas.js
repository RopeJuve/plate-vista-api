import { z } from "zod";

const required = (message) => z.string({ error: message }).trim().min(1, message);
// Blank means "not given", so it cannot satisfy the tax number / VAT ID rule.
const optionalId = z
  .string()
  .trim()
  .nullish()
  .transform((value) => value || null);

export const legalDetailsSchema = z
  .object({
    legalName: required("Legal name is required"),
    address: z.object(
      {
        street: required("Street is required"),
        zip: z
          .string({ error: "Postcode is required" })
          .trim()
          .regex(/^\d{5}$/, "Postcode must be 5 digits"),
        city: required("City is required"),
        country: z.literal("DE", { error: "Country must be DE" }).default("DE"),
      },
      { error: "Address is required" }
    ),
    taxNumber: optionalId,
    vatId: optionalId,
  })
  .superRefine((details, ctx) => {
    if (!details.taxNumber && !details.vatId) {
      ctx.addIssue({
        code: "custom",
        path: ["taxNumber"],
        message: "Tax number or VAT ID is required",
      });
    }
  });
