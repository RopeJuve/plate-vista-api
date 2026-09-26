import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { checkId, requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import {
  getOrdersByDate,
  getSalesByMenuItem,
  getTopCustomers,
  getTotalSales,
  getUserOrders,
} from "../ordering/order.stats.js";

const statisticsRouter = express.Router();

statisticsRouter.use(requireAuth, requireRole("admin"), requireTenant);

const send = (res, result) => {
  if (result?.error) return res.status(400).json({ error: result.error });
  return res.status(200).json(result);
};

statisticsRouter.get("/sales", asyncRoute(async (req, res) => {
  send(res, await getTotalSales(req.tenant.restaurantId, req.query));
}));

statisticsRouter.get("/sales/menu-items", asyncRoute(async (req, res) => {
  send(res, await getSalesByMenuItem(req.tenant.restaurantId, req.query));
}));

statisticsRouter.get("/orders/by-date", asyncRoute(async (req, res) => {
  send(res, await getOrdersByDate(req.tenant.restaurantId, req.query));
}));

statisticsRouter.get("/customers/top", asyncRoute(async (req, res) => {
  const parsedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isNaN(parsedLimit) ? 10 : Math.min(Math.max(parsedLimit, 1), 100);
  res.status(200).json(await getTopCustomers(req.tenant.restaurantId, limit));
}));

statisticsRouter.get("/:id/orders", checkId, asyncRoute(async (req, res) => {
  res.status(200).json(await getUserOrders(req.tenant.restaurantId, req.params.id));
}));

export default statisticsRouter;
