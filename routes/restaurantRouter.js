import express from "express";
import { validateRestaurantRegistration } from "../validators/restaurantValidators.js";
import { getRestaurants, registerRestaurant } from "../controllers/restaurantController.js";

const router = express.Router();

router.get("/", getRestaurants);
router.post("/", validateRestaurantRegistration, registerRestaurant);


export default router;
