import express from "express";
import {
  getMenuItems,
  createMenuItem,
  getMenuItem,
  updateMenuItem,
  deleteMenuItem,
  getAllCategory,
  deleteAllMenuItems,
} from "../controllers/menuItemControllers.js";
import {
  menuItemBodyValidation,
  menuItemUpdateValidation,
} from "../validators/menuItemvalidators.js";
import { checkId } from "../middlewares/usersMiddlewares.js";
import {
  checkBeforeCreate,
  checkItem,
} from "../middlewares/menuItemMiddlewares.js";

const menuItemRouter = express.Router();

menuItemRouter.get("/", getMenuItems);
menuItemRouter.get("/category", getAllCategory);
menuItemRouter.post(
  "/",
  menuItemBodyValidation,
  checkBeforeCreate,
  createMenuItem
);
menuItemRouter.get("/:id", checkId, checkItem, getMenuItem);
menuItemRouter.put(
  "/:id",
  checkId,
  checkItem,
  menuItemUpdateValidation,
  updateMenuItem
);
menuItemRouter.delete("/:id", checkId, checkItem, deleteMenuItem);
menuItemRouter.delete("/", deleteAllMenuItems);

export default menuItemRouter;
