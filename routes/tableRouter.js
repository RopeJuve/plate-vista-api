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

const tableRouter = express.Router();

tableRouter.get("/", getTables);
tableRouter.post("/", tableBodyValidator, checkBeforeCreateTable, createTable);
tableRouter.get("/:id", checkId, checkTable, getTableById);
tableRouter.put("/:id", checkId, checkTable, tableUpdateValidator, updateTable);
tableRouter.delete("/:id", checkId, deleteTable);

export default tableRouter;
