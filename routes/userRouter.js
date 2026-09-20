import express from "express";
import {
  createUser,
  deleteUser,
  getUserById,
  getUsers,
  updateUser,
} from "../controllers/userControllers.js";
import {
  userBodyValidation,
  userUpdateValidation,
} from "../validators/userValidators.js";
import {
  checkBeforeCreate,
  checkId,
  checkUser,
} from "../middlewares/usersMiddlewares.js";
import {
  requireAuth,
  requireRole,
  requireSelfOrAdmin,
} from "../middlewares/jwtMiddlewares.js";

const userRouter = express.Router();

userRouter.get("/", requireAuth, requireRole("admin"), getUsers);
// Registration stays public; rate-limited at the app level (see index.js).
userRouter.post("/", userBodyValidation, checkBeforeCreate, createUser);
userRouter.get(
  "/:id",
  checkId,
  requireAuth,
  requireSelfOrAdmin,
  checkUser,
  getUserById
);
userRouter.put(
  "/:id",
  checkId,
  requireAuth,
  requireSelfOrAdmin,
  checkUser,
  userUpdateValidation,
  updateUser
);
userRouter.delete(
  "/:id",
  checkId,
  requireAuth,
  requireRole("admin"),
  checkUser,
  deleteUser
);

export default userRouter;
