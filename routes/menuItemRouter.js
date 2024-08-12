import express from "express";
import {
  getMenuItems,
  createMenuItem,
  getMenuItem,
  updateMenuItem,
  deleteMenuItem,
} from "../controllers/menuItemControllers.js";
import { checkId } from "../middlewares/usersMiddlewares.js";

const menuItemRouter = express.Router();

menuItemRouter.get("/", getMenuItems);
menuItemRouter.post("/", createMenuItem);
menuItemRouter.get("/:id", checkId, getMenuItem);
menuItemRouter.put("/:id", checkId, updateMenuItem);
menuItemRouter.delete("/:id", checkId, deleteMenuItem);

export default menuItemRouter;
