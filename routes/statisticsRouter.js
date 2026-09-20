import express from "express";

import {
  getTotalSales,
  getSalesByMenuItem,
  getOrdersByDate,
  getTopCustomers,
  getUserOrdersByDate,
} from "../controllers/statisticsController.js";
import { checkId } from "../middlewares/usersMiddlewares.js";
import { requireAuth, requireRole } from "../middlewares/jwtMiddlewares.js";

const statisticRouter = express.Router();

statisticRouter.use(requireAuth, requireRole("admin"));

statisticRouter.get("/sales", getTotalSales);
statisticRouter.get("/sales/menu-items", getSalesByMenuItem);
statisticRouter.get("/orders/by-date", getOrdersByDate);
statisticRouter.get("/:id/orders", checkId, getUserOrdersByDate);
statisticRouter.get("/customers/top", getTopCustomers);

export default statisticRouter;
