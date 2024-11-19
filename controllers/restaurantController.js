import Restaurant from "../models/restaurant.model.js";
import { dbManager } from "../utils/dbManager.js";
import { hashPassword } from "../utils/index.js";

export const getRestaurants = async (req, res) => {
  try {
    const restaurants = await Restaurant.find();
    res.status(200).json(restaurants);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const registerRestaurant = async (req, res) => {
  try {
    const { restaurantName, email, password } = req.body;

    const baseUrl = process.env.MONGO_DB_URL;

    const hashedPassword = await hashPassword(password);
    const databaseUrl = await dbManager.createRestaurantDB(
      {
        restaurantName,
        email,
        password: hashedPassword,
      },
      baseUrl,
      process.env.MONGO_DB_OPTIONS
    );

    const restaurant = new Restaurant({
      restaurantName,
      email,
      password: hashedPassword,
      databaseUrl,
    });

    await restaurant.save();

    res.status(201).json({
      message: "Restaurant registered successfully",
      restaurantId: restaurant._id,
    });
  } catch (error) {
    console.error("Restaurant registration error:", error);
    res.status(500).json({
      message: "Registration failed. Please try again.",
      error: error.message,
    });
  }
};
