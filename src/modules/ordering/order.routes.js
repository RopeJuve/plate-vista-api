import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { parsePagination } from "../../shared/auth.js";
import { checkId, requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { getOrder, listOrders } from "./order.service.js";

const orderRouter = express.Router();

const staff = [requireAuth, requireRole("employee"), requireTenant];

const gone = (_req, res) => {
  res.status(405).json({
    code: "VALIDATION",
    message: "Order changes go through the WebSocket connection",
  });
};

orderRouter.get("/", ...staff, asyncRoute(async (req, res) => {
  const page = parsePagination(req.query);
  const result = await listOrders(req.tenant.restaurantId, page);
  res.status(200).json({ ...result, page: page.page, limit: page.limit });
}));

orderRouter.post("/", ...staff, gone);
orderRouter.put("/:id", ...staff, checkId, gone);
orderRouter.put("/:id/status", ...staff, checkId, gone);
orderRouter.delete("/:id", ...staff, checkId, gone);

orderRouter.get("/:id", ...staff, checkId, asyncRoute(async (req, res) => {
  res.status(200).json(await getOrder(req.tenant.restaurantId, req.params.id));
}));

export default orderRouter;
