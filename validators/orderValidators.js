import { body, validationResult } from "express-validator";

export const checkBody = [
  body("user")
    .optional()
    .isMongoId()
    .withMessage("user must be a valid MongoId"),
  body("menuItems")
    .isArray()
    .withMessage("menuItems must be an array")
    .notEmpty()
    .withMessage("menuItems cannot be empty"),
  body("menuItems.*.product")
    .isMongoId()
    .withMessage("product must be a valid MongoId"),
  body("menuItems.*.quantity")
    .isInt({ gt: 0 })
    .withMessage("quantity must be an positive integer"),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }
    next();
  },
];
