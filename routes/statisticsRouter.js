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
