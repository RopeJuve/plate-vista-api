import express from "express";

import {
  getTotalSales,
  getSalesByMenuItem,
  getOrdersByDate,
  getTopCustomers,
  getUserOrdersByDate,
} from "../controllers/statisticsController.js";

const statisticRouter = express.Router();

statisticRouter.get("/sales", getTotalSales);
statisticRouter.get("/sales/menu-items", getSalesByMenuItem);
statisticRouter.get("/orders/by-date", getOrdersByDate);
statisticRouter.get("/:id/orders", getUserOrdersByDate);
statisticRouter.get("/customers/top", getTopCustomers);

export default statisticRouter;

/**
 * @swagger
 * /statistics/sales:
 *   get:
 *     summary: Get total sales statistics
 *     responses:
 *       200:
 *         description: Sales statistics
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Statistics'
 * 
 * /statistics/sales/menu-items:
 *   get:
 *     summary: Get sales statistics by menu item
 *     responses:
 *       200:
 *         description: Menu item sales statistics
 * 
 * /statistics/orders/by-date:
 *   get:
 *     summary: Get orders grouped by date
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Orders by date
 * 
 * /statistics/customers/top:
 *   get:
 *     summary: Get top customers by order value
 *     responses:
 *       200:
 *         description: List of top customers
 */
