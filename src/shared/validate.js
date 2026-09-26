import { AppError } from "./errors.js";

export const zodFieldErrors = (error) => {
  const fields = {};
  for (const issue of error?.issues || []) {
    const key = issue.path.join(".").replace(/^payload\./, "") || "request";
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
};

export const parseOrThrow = (schema, data) => {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const fields = zodFieldErrors(parsed.error);
    const message = Object.values(fields)[0] || "Invalid request";
    throw new AppError("VALIDATION", message, 400, { fields });
  }
  return parsed.data;
};
