import { check, validationResult } from "express-validator";

export const menuItemBodyValidation = [
  check("title", "Title is required")
    .not()
    .isEmpty()
    .isString()
    .isLength({ min: 3 })
    .withMessage("Title must be at least 3 characters long"),
  check("description", "Description is required")
    .not()
    .isEmpty()
    .isString()
    .withMessage("Description must be a string"),
  check("price", "Price is required")
    .not()
    .isEmpty()
    .isNumeric()
    .withMessage("Price must be a number"),
  check("image", "Image is required")
    .not()
    .isEmpty()
    .isString()
    .withMessage("Image must be a string"),
  check("category", "Category is required")
    .not()
    .isEmpty()
    .isString()
    .withMessage("Category must be a string"),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    next();
  },
];

export const menuItemUpdateValidation = [
  check("title")
    .not()
    .isEmpty()
    .isString()
    .isLength({ min: 3 })
    .withMessage("Title must be at least 3 characters long")
    .optional(),
  check("description")
    .not()
    .isEmpty()
    .isString()
    .withMessage("Description must be a string")
    .optional(),
  check("price")
    .not()
    .isEmpty()
    .isNumeric()
    .withMessage("Price must be a number")
    .optional(),
  check("image")
    .not()
    .isEmpty()
    .isString()
    .withMessage("Image must be a string")
    .optional(),
  check("category")
    .not()
    .isEmpty()
    .isString()
    .withMessage("Category must be a string")
    .optional(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    next();
  },
];
