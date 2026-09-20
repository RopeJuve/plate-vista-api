import express from "express";

import {
  getTables,
  createTable,
  updateTable,
  deleteTable,
  getTableById,
} from "../controllers/tableControllers.js";
import {
  tableBodyValidator,
  tableUpdateValidator,
} from "../validators/tableValidators.js";
import { checkId } from "../middlewares/usersMiddlewares.js";
import {
  checkBeforeCreateTable,
  checkTable,
} from "../middlewares/tableMiddlewares.js";
import { requireAuth, requireRole } from "../middlewares/jwtMiddlewares.js";

const tableRouter = express.Router();

// Every table route requires an employee; mutations require admin.
tableRouter.use(requireAuth, requireRole("employee"));

tableRouter.get("/", getTables);
tableRouter.post(
  "/",
  requireRole("admin"),
  tableBodyValidator,
  checkBeforeCreateTable,
  createTable
);
tableRouter.get("/:id", checkId, checkTable, getTableById);
tableRouter.put(
  "/:id",
  requireRole("admin"),
  checkId,
  checkTable,
  tableUpdateValidator,
  updateTable
);
tableRouter.delete(
  "/:id",
  requireRole("admin"),
  checkId,
  checkTable,
  deleteTable
);

export default tableRouter;
