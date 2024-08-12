import { check, validationResult } from "express-validator";

export const userBodyValidation = [
  check("username", "Username is required")
    .not()
    .isEmpty()
    .isLength({ min: 4 }),
  check("email", "Invalid email").isEmail(),
  check(
    "password",
    "Password is required",
    "Password minimum 6 characters"
  ).isLength({ min: 6 }),
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
  check("email", "Email is required").isEmail().optional(),
  check("password", "Password is required").isLength({ min: 6 }).optional(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array()[0].msg });
    }
    next();
  },
];
