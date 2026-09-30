import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { checkId, requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import {
  createCategory,
  deleteCategory,
  listCategories,
  moveCategory,
  updateCategory,
} from "./category.service.js";

const categoryRouter = express.Router();
const read = [requireAuth, requireRole("employee"), requireTenant];
const write = [requireAuth, requireRole("admin"), requireTenant];

categoryRouter.get("/", ...read, asyncRoute(async (req, res) => {
  res.status(200).json(await listCategories(req.tenant.restaurantId));
}));

categoryRouter.post("/", ...write, asyncRoute(async (req, res) => {
  res.status(201).json(await createCategory(req.tenant.restaurantId, req.body));
}));

categoryRouter.put("/:id", ...write, checkId, asyncRoute(async (req, res) => {
  res.status(200).json(await updateCategory(req.tenant.restaurantId, req.params.id, req.body));
}));

// Body: { direction: "up" | "down" }. Responds with the reordered list.
categoryRouter.post("/:id/move", ...write, checkId, asyncRoute(async (req, res) => {
  res.status(200).json(await moveCategory(req.tenant.restaurantId, req.params.id, req.body));
}));

categoryRouter.delete("/:id", ...write, checkId, asyncRoute(async (req, res) => {
  await deleteCategory(req.tenant.restaurantId, req.params.id);
  res.status(204).end();
}));

export default categoryRouter;
