import { AppError } from "./errors.js";

export const parseOrThrow = (schema, data) => {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError("VALIDATION", issue?.message || "Invalid request");
  }
  return parsed.data;
};
