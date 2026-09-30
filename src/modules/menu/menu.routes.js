import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { parseOrThrow } from "../../shared/validate.js";
import { checkId, requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { createMenuSchema, updateMenuSchema } from "./menu.schemas.js";
import { signMenuImageUpload } from "../../shared/cloudinary.js";
import {
  archiveMenuItem,
  createMenuItem,
  getBySlug,
  getMenuItem,
  listBySlug,
  listCategories,
  listMenuItems,
  updateMenuItem,
} from "./menu.service.js";

const menuRouter = express.Router();
const read = [requireAuth, requireRole("employee", "guest"), requireTenant];
const write = [requireAuth, requireRole("admin"), requireTenant];

menuRouter.get("/", ...read, asyncRoute(async (req, res) => {
  const category = req.query.category;
  if (category !== undefined && typeof category !== "string") {
    return res.status(400).json({ error: "category must be a string" });
  }
  res.status(200).json(await listMenuItems(req.tenant.restaurantId, category));
}));

menuRouter.get("/category", ...read, asyncRoute(async (req, res) => {
  res.status(200).json(await listCategories(req.tenant.restaurantId));
}));

menuRouter.post("/", ...write, asyncRoute(async (req, res) => {
  const body = parseOrThrow(createMenuSchema, req.body);
  res.status(201).json(await createMenuItem(req.tenant.restaurantId, body));
}));

// Responds with what the browser needs to upload one image to Cloudinary.
menuRouter.post("/upload-signature", ...write, (req, res) => {
  res.status(200).json(signMenuImageUpload(req.tenant.restaurantId));
});

menuRouter.get("/:id", ...read, checkId, asyncRoute(async (req, res) => {
  res.status(200).json(await getMenuItem(req.tenant.restaurantId, req.params.id));
}));

menuRouter.put("/:id", ...write, checkId, asyncRoute(async (req, res) => {
  const body = parseOrThrow(updateMenuSchema, req.body);
  res.status(200).json(await updateMenuItem(req.tenant.restaurantId, req.params.id, body));
}));

menuRouter.delete("/:id", ...write, checkId, asyncRoute(async (req, res) => {
  await archiveMenuItem(req.tenant.restaurantId, req.params.id);
  res.status(200).json({ message: "MenuItem deleted successfully" });
}));

export default menuRouter;

export const publicMenuRouter = express.Router();

publicMenuRouter.get("/:slug/menu-items", asyncRoute(async (req, res) => {
  res.status(200).json(await listBySlug(req.params.slug, req.query.category));
}));

publicMenuRouter.get("/:slug/menu-items/category", asyncRoute(async (req, res) => {
  const restaurantItems = await listBySlug(req.params.slug);
  res.status(200).json([...new Set(restaurantItems.map((item) => item.category))]);
}));

publicMenuRouter.get("/:slug/menu-items/:id", checkId, asyncRoute(async (req, res) => {
  res.status(200).json(await getBySlug(req.params.slug, req.params.id));
}));
