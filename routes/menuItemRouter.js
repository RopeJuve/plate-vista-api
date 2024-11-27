import express from "express";
import {
  getMenuItems,
  createMenuItem,
  getMenuItem,
  updateMenuItem,
  deleteMenuItem,
  getAllCategory,
  deleteAllMenuItems,
} from "../controllers/menuItemControllers.js";
import {
  menuItemBodyValidation,
  menuItemUpdateValidation,
} from "../validators/menuItemvalidators.js";
import { checkId } from "../middlewares/usersMiddlewares.js";
import {
  checkBeforeCreate,
  checkItem,
} from "../middlewares/menuItemMiddlewares.js";
import { upload } from "../cloudinary/cloudinary.js";

const menuItemRouter = express.Router();

menuItemRouter.get("/", getMenuItems);
menuItemRouter.get("/category", getAllCategory);
menuItemRouter.post(
  "/",
  upload.single("image"),
  menuItemBodyValidation,
  checkBeforeCreate,
  createMenuItem
);
menuItemRouter.get("/:id", checkId, checkItem, getMenuItem);
menuItemRouter.put(
  "/:id",
  checkId,
  checkItem,
  upload.single("image"),
  menuItemUpdateValidation,
  updateMenuItem
);
menuItemRouter.delete("/:id", checkId, checkItem, deleteMenuItem);
menuItemRouter.delete("/", deleteAllMenuItems);

export default menuItemRouter;
/**
 * @swagger
 * /menu-items:
 *   get:
 *     summary: Get all menu items
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter menu items by category
 *     responses:
 *       200:
 *         description: List of menu items
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/MenuItem'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 * 
 *   post:
 *     summary: Create a new menu item
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               price:
 *                 type: number
 *               category:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Menu item created successfully
 *       400:
 *         description: Validation error
 *       409:
 *         description: Item already exists
 *       500:
 *         description: Server error
 */

/**
 * @swagger
 * /menu-items/{id}:
 *   get:
 *     summary: Get a menu item by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Menu item details
 *       404:
 *         description: Item not found
 * 
 *   put:
 *     summary: Update a menu item
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               price:
 *                 type: number
 *               category:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Menu item updated successfully
 *       404:
 *         description: Item not found
 * 
 *   delete:
 *     summary: Delete a menu item
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Menu item deleted successfully
 *       404:
 *         description: Item not found
 */
