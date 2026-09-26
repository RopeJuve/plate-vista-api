import { AppError } from "../../shared/errors.js";

export const ORDER_STATUSES = [
  "pending",
  "accepted",
  "preparing",
  "ready",
  "served",
  "cancelled",
];

export const ALLOWED_TRANSITIONS = {
  pending: ["accepted", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready"],
  ready: ["served"],
  served: [],
  cancelled: [],
};

export const assertTransition = (from, to) => {
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new AppError(
      "INVALID_TRANSITION",
      `Cannot change status from ${from} to ${to}`,
      undefined,
      { from, to }
    );
  }
};
