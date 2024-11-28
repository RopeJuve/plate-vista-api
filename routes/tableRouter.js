import express from "express";

import {
  getTables,
  createTable,
  updateTable,
  deleteTable,
  getTableById,
  deleteAllTables,
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
tableRouter.delete("/", deleteAllTables);

export default tableRouter;

/**
 * @swagger
 * /table:
 *   get:
 *     summary: Get all tables
 *     responses:
 *       200:
 *         description: List of tables
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Table'
 * 
 *   post:
 *     summary: Create a new table
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Table'
 *     responses:
 *       201:
 *         description: Table created successfully
 * 
 * /table/{id}:
 *   get:
 *     summary: Get table by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Table details
 * 
 *   put:
 *     summary: Update table
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Table'
 *     responses:
 *       200:
 *         description: Table updated successfully
 * 
 *   delete:
 *     summary: Delete table
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Table deleted successfully
 */