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
import { checkBody, checkStatusBody } from "../validators/orderValidators.js";
import { requireAuth, requireRole } from "../middlewares/jwtMiddlewares.js";

const orderRouter = express.Router();

orderRouter.get("/", requireAuth, requireRole("employee"), getOrders);
// Any authenticated user or employee may place an order.
orderRouter.post("/", requireAuth, checkBody, createOrder);
orderRouter.get(
  "/:id",
  requireAuth,
  requireRole("employee"),
  checkId,
  checkOrderExists,
  getOrder
);
orderRouter.put(
  "/:id",
  requireAuth,
  requireRole("employee"),
  checkId,
  checkOrderExists,
  updateOrder
);
orderRouter.put(
  "/:id/status",
  requireAuth,
  requireRole("employee"),
  checkId,
  checkOrderExists,
  checkStatusBody,
  updateOrderStatus
);
orderRouter.delete(
  "/:id",
  requireAuth,
  requireRole("employee"),
  checkId,
  checkOrderExists,
  deleteOrder
);

export default orderRouter;
