import express from "express";

import {
  getTotalSales,
  getSalesByMenuItem,
  getOrdersByDate,
} from "../controllers/statisticsController.js";

const router = express.Router();

router.get("/sales", getTotalSales);
router.get("/sales/menu-items", getSalesByMenuItem);
router.get("/orders/by-date", getOrdersByDate);

export default router;
