import express from "express";
import { validateRestaurantRegistration } from "../validators/restaurantValidators.js";
import { getRestaurants, registerRestaurant } from "../controllers/restaurantController.js";

const router = express.Router();

router.get("/", getRestaurants);
router.post("/", validateRestaurantRegistration, registerRestaurant);


export default router;

/**
 * @swagger
 * /restaurant:
 *   get:
 *     summary: Get all restaurants
 *     responses:
 *       200:
 *         description: List of restaurants
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Restaurant'
 *   post:
 *     summary: Register a new restaurant
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Restaurant'
 *     responses:
 *       201:
 *         description: Restaurant registered successfully
 *       400:
 *         description: Validation error
 */
