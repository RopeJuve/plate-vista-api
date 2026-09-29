import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { checkId, requireAuth, requireRole, requireTenant } from "./auth.middleware.js";
import {
  createEmployee,
  deleteEmployee,
  getEmployee,
  listEmployees,
  updateEmployee,
} from "./staff.service.js";

const employeeRouter = express.Router();

employeeRouter.use(requireAuth, requireRole("admin"), requireTenant);

employeeRouter.get("/", asyncRoute(async (req, res) => {
  res.status(200).json(await listEmployees(req.tenant.restaurantId));
}));

employeeRouter.post("/", asyncRoute(async (req, res) => {
  res.status(201).json(await createEmployee(req.tenant.restaurantId, req.user.id, req.body));
}));

employeeRouter.get("/:id", checkId, asyncRoute(async (req, res) => {
  res.status(200).json(await getEmployee(req.tenant.restaurantId, req.params.id));
}));

employeeRouter.put("/:id", checkId, asyncRoute(async (req, res) => {
  res.status(200).json(
    await updateEmployee(req.tenant.restaurantId, req.user.id, req.params.id, req.body)
  );
}));

employeeRouter.delete("/:id", checkId, asyncRoute(async (req, res) => {
  await deleteEmployee(req.tenant.restaurantId, req.user.id, req.params.id);
  res.status(200).json({ message: "Employee deleted successfully" });
}));

export default employeeRouter;
