import express from "express";
import {
  createOrder,
  deleteAllOrders,
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
orderRouter.delete("/", deleteAllOrders);

export default orderRouter;

/**
 * @swagger
 * /orders:
 *   get:
 *     summary: Get all orders
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of orders
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Order'
 * 
 *   post:
 *     summary: Create a new order
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Order'
 *     responses:
 *       201:
 *         description: Order created successfully
 * 
 * /orders/{id}:
 *   put:
 *     summary: Update order status
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string }
 *     responses:
 *       200:
 *         description: Order updated successfully
 */
