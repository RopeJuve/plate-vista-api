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
