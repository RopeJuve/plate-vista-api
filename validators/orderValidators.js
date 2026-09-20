import { body, validationResult } from "express-validator";
import { ORDER_STATUSES } from "../utils/orderStatuses.js";

export const checkStatusBody = [
  body("orderStatus")
    .isIn(ORDER_STATUSES)
    .withMessage(`orderStatus must be one of: ${ORDER_STATUSES.join(", ")}`),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }
    next();
  },
];

// user is intentionally not accepted here: the server derives it from the
// authenticated identity, never from the client (see createOrder).
export const checkBody = [
  body("menuItems")
    .isArray({ min: 1, max: 50 })
    .withMessage("menuItems must be a non-empty array of at most 50 items"),
  body("menuItems.*.product")
    .isMongoId()
    .withMessage("product must be a valid MongoId"),
  body("menuItems.*.quantity")
    .isInt({ gt: 0, lt: 100 })
    .withMessage("quantity must be a positive integer less than 100"),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }
    next();
  },
];
