import { check, validationResult } from "express-validator";

export const employeeBodyValidation = [
  check("employee", "Employee name is required")
    .not()
    .isEmpty()
    .isLength({ min: 4 })
    .withMessage("Employee name must be at least 4 characters long"),
  check("email", "Email is required")
    .not()
    .isEmpty()
    .isEmail()
    .withMessage("Invalid email"),
  check("password", "Password is required")
    .not()
    .isEmpty()
    .isLength({ min: 4 })
    .withMessage("Password must be at least 4 characters long"),
  check("position", "Position is required")
    .not()
    .isEmpty()
    .isLength({ min: 3 })
    .withMessage("Position must be at least 3 characters long"),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
];

export const employeeUpdateValidation = [
  check("employee")
    .isLength({ min: 4 })
    .withMessage("Employee name must be at least 4 characters long")
    .optional(),
  check("email").isEmail().withMessage("Invalid email").optional(),
  check("password")
    .isLength({ min: 4 })
    .withMessage("Password must be at least 4 characters long")
    .optional(),
  check("position")
    .isLength({ min: 3 })
    .withMessage("Position must be at least 3 characters long")
    .optional(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array()[0].msg });
    }
    next();
  },
];
