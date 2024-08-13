import { check, validationResult } from "express-validator";

export const userBodyValidation = [
  check("username", "Username is required")
    .not()
    .isEmpty()
    .isLength({ min: 4 })
    .withMessage("Username must be at least 4 characters long"),
  check("email", "Invalid is required").isEmail().withMessage("Invalid email"),
  check("password", "Password is required")
    .not()
    .isEmpty()
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters long"),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
];

export const userUpdateValidation = [
  check("username", "Username is required")
    .not()
    .isEmpty()
    .isLength({ min: 4 })
    .optional(),
  check("email", "Email is required")
    .isEmail()
    .withMessage("Invalid email")
    .optional(),
  check("password", "Password is required")
    .isLength({ min: 6 })
    .withMessage("Password must be at least 6 characters long")
    .optional(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array()[0].msg });
    }
    next();
  },
];
