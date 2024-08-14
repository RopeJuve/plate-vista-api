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

const userRouter = express.Router();

userRouter.get("/", getUsers);
userRouter.post("/", userBodyValidation, checkBeforeCreate, createUser);
userRouter.get("/:id", checkId, checkUser, getUserById);
//TODO: Add the /:id/orders route here
userRouter.put(
  "/:id",
  checkId,
  checkUser,
  userUpdateValidation,
  checkUser,
  updateUser
);
userRouter.delete("/:id", checkId, checkUser, deleteUser);

export default userRouter;
