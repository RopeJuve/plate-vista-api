import express from "express";
import {
  getEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
} from "../controllers/employeeControllers.js";
import {
  employeeBodyValidation,
  employeeUpdateValidation,
} from "../validators/EmployeeValidators.js";
import { checkId } from "../middlewares/usersMiddlewares.js";
import { checkEmployee } from "../middlewares/employeeMiddleware.js";
const employeeRouter = express.Router();

employeeRouter.get("/", getEmployees);
employeeRouter.post("/", employeeBodyValidation, createEmployee);
employeeRouter.get("/:id", checkId, checkEmployee, getEmployeeById);
employeeRouter.put(
  "/:id",
  checkId,
  employeeUpdateValidation,
  checkEmployee,
  updateEmployee
);
employeeRouter.delete("/:id", checkId, checkEmployee, deleteEmployee);

export default employeeRouter;

/**
 * @swagger
 * /employee:
 *   get:
 *     summary: Get all employees
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of employees
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Employee'
 * 
 *   post:
 *     summary: Create a new employee
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Employee'
 *     responses:
 *       201:
 *         description: Employee created successfully
 * 
 * /employee/{id}:
 *   get:
 *     summary: Get employee by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Employee details
 *       404:
 *         description: Employee not found
 * 
 *   put:
 *     summary: Update employee
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
 *             $ref: '#/components/schemas/Employee'
 *     responses:
 *       200:
 *         description: Employee updated successfully
 * 
 *   delete:
 *     summary: Delete employee
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Employee deleted successfully
 */
