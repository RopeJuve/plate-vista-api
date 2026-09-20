import { check, validationResult } from "express-validator";

const TABLE_STATUSES = ["occupied", "vacant", "reserved"];

export const tableBodyValidator = [
  check("tableNumber", "Table number is required")
    .not()
    .isEmpty()
    .isNumeric()
    .withMessage("Table number must be a number"),
  check("capacity", "Capacity is required")
    .not()
    .isEmpty()
    .isNumeric()
    .withMessage("Capacity must be a number"),
  check("status")
    .isIn(TABLE_STATUSES)
    .withMessage(`Status must be one of: ${TABLE_STATUSES.join(", ")}`)
    .optional(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
];

export const tableUpdateValidator = [
  check("tableNumber")
    .isNumeric()
    .withMessage("Table number must be a number")
    .optional(),
  check("capacity")
    .isNumeric()
    .withMessage("Capacity must be a number")
    .optional(),
  check("status")
    .isIn(TABLE_STATUSES)
    .withMessage(`Status must be one of: ${TABLE_STATUSES.join(", ")}`)
    .optional(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
];
