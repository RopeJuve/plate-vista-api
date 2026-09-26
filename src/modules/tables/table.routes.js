import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { parseOrThrow } from "../../shared/validate.js";
import { checkId, requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { createTableSchema, updateTableSchema } from "./table.schemas.js";
import {
  createTable,
  deleteTable,
  getTable,
  listTables,
  regenerateQrCode,
  updateTable,
} from "./table.service.js";

const tableRouter = express.Router();

tableRouter.use(requireAuth, requireRole("employee"), requireTenant);

tableRouter.get("/", asyncRoute(async (req, res) => {
  res.status(200).json(await listTables(req.tenant.restaurantId));
}));

tableRouter.post("/", requireRole("admin"), asyncRoute(async (req, res) => {
  const body = parseOrThrow(createTableSchema, req.body);
  res.status(201).json(await createTable(req.tenant.restaurantId, body));
}));

tableRouter.get("/:id", checkId, asyncRoute(async (req, res) => {
  res.status(200).json(await getTable(req.tenant.restaurantId, req.params.id));
}));

tableRouter.post("/:id/qr", requireRole("admin"), checkId, asyncRoute(async (req, res) => {
  res.status(200).json(await regenerateQrCode(req.tenant.restaurantId, req.params.id));
}));

tableRouter.put("/:id", requireRole("admin"), checkId, asyncRoute(async (req, res) => {
  const body = parseOrThrow(updateTableSchema, req.body);
  res.status(200).json(await updateTable(req.tenant.restaurantId, req.params.id, body));
}));

tableRouter.delete("/:id", requireRole("admin"), checkId, asyncRoute(async (req, res) => {
  await deleteTable(req.tenant.restaurantId, req.params.id);
  res.status(200).json({ message: "Table deleted successfully." });
}));

export default tableRouter;
