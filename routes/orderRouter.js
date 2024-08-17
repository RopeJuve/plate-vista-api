import express from "express";
import {
  createOrder,
  deleteOrder,
  getOrder,
  getOrders,
  updateOrder,
  updateOrderStatus,
} from "../controllers/orderControllers.js";
import { checkOrderExists } from "../middlewares/orderMiddlewares.js";
import { checkId } from "../middlewares/usersMiddlewares.js";
import { checkBody } from "../validators/orderValidators.js";

const orderRouter = express.Router();

orderRouter.get("/", getOrders);
//TODO: Add the /sortByDate and /total-by-date route here
orderRouter.post("/", checkBody, createOrder);
orderRouter.get("/:id", checkId, checkOrderExists, getOrder);
orderRouter.put("/:id", checkId, checkOrderExists, updateOrder);
orderRouter.put("/:id/status", checkId, checkOrderExists, updateOrderStatus);
orderRouter.delete("/:id", checkId, checkOrderExists, deleteOrder);

export default orderRouter;
