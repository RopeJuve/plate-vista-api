import express from "express";
import {
  getMenuItems,
  createMenuItem,
  getMenuItem,
  updateMenuItem,
  deleteMenuItem,
  getAllCategory,
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
import { requireAuth, requireRole } from "../middlewares/jwtMiddlewares.js";

const menuItemRouter = express.Router();

menuItemRouter.get("/", getMenuItems);
menuItemRouter.get("/category", getAllCategory);
menuItemRouter.post(
  "/",
  requireAuth,
  requireRole("admin"),
  menuItemBodyValidation,
  checkBeforeCreate,
  createMenuItem
);
menuItemRouter.get("/:id", checkId, checkItem, getMenuItem);
menuItemRouter.put(
  "/:id",
  requireAuth,
  requireRole("admin"),
  checkId,
  checkItem,
  menuItemUpdateValidation,
  updateMenuItem
);
menuItemRouter.delete(
  "/:id",
  requireAuth,
  requireRole("admin"),
  checkId,
  checkItem,
  deleteMenuItem
);

export default menuItemRouter;
