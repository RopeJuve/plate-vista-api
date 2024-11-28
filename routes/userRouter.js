import express from "express";
import {
  createUser,
  deleteUser,
  getUserById,
  getUsers,
  updateUser,
} from "../controllers/userControllers.js";
import {
  userBodyValidation,
  userUpdateValidation,
} from "../validators/userValidators.js";
import {
  checkBeforeCreate,
  checkId,
  checkUser,
} from "../middlewares/usersMiddlewares.js";

const userRouter = express.Router();

userRouter.get("/", getUsers);
userRouter.post("/", userBodyValidation, checkBeforeCreate, createUser);
userRouter.get("/:id", checkId, checkUser, getUserById);
//TODO: Add the /:id/orders route here
userRouter.put(
  "/:id",
  checkId,
  checkUser,
  userUpdateValidation,
  checkUser,
  updateUser
);
userRouter.delete("/:id", checkId, checkUser, deleteUser);

export default userRouter;


/**
 * @swagger
 * /users:
 *   get:
 *     summary: Get all users
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of users
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 * 
 *   post:
 *     summary: Create a new user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/User'
 *     responses:
 *       201:
 *         description: User created successfully
 * 
 * /users/{id}:
 *   get:
 *     summary: Get user by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User details
 * 
 *   put:
 *     summary: Update user
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
 *             $ref: '#/components/schemas/User'
 *     responses:
 *       200:
 *         description: User updated successfully
 * 
 *   delete:
 *     summary: Delete user
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User deleted successfully
 */