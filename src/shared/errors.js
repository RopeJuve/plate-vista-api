export const ErrorCodes = {
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  OUT_OF_STOCK: "OUT_OF_STOCK",
  FORBIDDEN: "FORBIDDEN",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  SESSION_CLOSED: "SESSION_CLOSED",
  INTERNAL: "INTERNAL",
};

const STATUS_BY_CODE = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  OUT_OF_STOCK: 409,
  FORBIDDEN: 403,
  INVALID_TRANSITION: 409,
  SESSION_CLOSED: 409,
  INTERNAL: 500,
};

export class AppError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 500;
  }
}

export const isDuplicateKey = (error) =>
  error?.code === 11000 || error?.cause?.code === 11000;

export const duplicateKeyOn = (error) => {
  if (!isDuplicateKey(error)) return null;
  const text = `${error.message || ""} ${error.cause?.message || ""}`;
  if (text.includes("clientOrderId")) return "clientOrderId";
  if (text.includes("tableId")) return "tableId";
  if (text.includes("title")) return "title";
  if (text.includes("tableNumber")) return "tableNumber";
  return "unknown";
};
