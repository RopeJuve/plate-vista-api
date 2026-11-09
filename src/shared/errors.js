export const ErrorCodes = {
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  OUT_OF_STOCK: "OUT_OF_STOCK",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  JOIN_CODE_REQUIRED: "JOIN_CODE_REQUIRED",
  JOIN_CODE_INVALID: "JOIN_CODE_INVALID",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  SESSION_CLOSED: "SESSION_CLOSED",
  RATE_LIMITED: "RATE_LIMITED",
  RESTAURANT_DETAILS_MISSING: "RESTAURANT_DETAILS_MISSING",
  TSE_SETUP_FAILED: "TSE_SETUP_FAILED",
  TSE_NOT_ACTIVE: "TSE_NOT_ACTIVE",
  BILL_PAID: "BILL_PAID",
  BILL_CHANGED: "BILL_CHANGED",
  BILL_EMPTY: "BILL_EMPTY",
  BILL_UNPAID: "BILL_UNPAID",
  INTERNAL: "INTERNAL",
};

const STATUS_BY_CODE = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  OUT_OF_STOCK: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  JOIN_CODE_REQUIRED: 403,
  JOIN_CODE_INVALID: 403,
  INVALID_TRANSITION: 409,
  SESSION_CLOSED: 409,
  RATE_LIMITED: 429,
  RESTAURANT_DETAILS_MISSING: 422,
  TSE_SETUP_FAILED: 502,
  TSE_NOT_ACTIVE: 412,
  BILL_PAID: 409,
  BILL_CHANGED: 409,
  BILL_EMPTY: 422,
  BILL_UNPAID: 409,
  INTERNAL: 500,
};

export class AppError extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 500;
    if (details !== undefined) this.details = details;
  }
}

export const isDuplicateKey = (error) =>
  error?.code === 11000 || error?.cause?.code === 11000;

export const duplicateKeyOn = (error) => {
  if (!isDuplicateKey(error)) return null;
  const text = `${error.message || ""} ${error.cause?.message || ""}`;
  if (text.includes("clientOrderId")) return "clientOrderId";
  if (text.includes("clientPaymentId")) return "clientPaymentId";
  if (text.includes("tableId")) return "tableId";
  if (text.includes("title")) return "title";
  if (text.includes("tableNumber")) return "tableNumber";
  return "unknown";
};
