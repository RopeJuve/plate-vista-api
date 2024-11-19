import { dbManager } from '../utils/dbManager.js';

export const connectRestaurantDb = async (req, res, next) => {
  try {
    const restaurantId = req.headers['x-restaurant-id'];
    
    if (!restaurantId) {
      return res.status(400).json({ message: 'Restaurant ID is required' });
    }

    const connection = await dbManager.connectToRestaurantDB(restaurantId);
    req.dbConnection = connection;
    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};