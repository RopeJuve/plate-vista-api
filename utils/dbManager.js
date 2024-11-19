import mongoose from "mongoose";
import Restaurant from "../models/restaurant.model.js";
import User from "../models/user.model.js";
import Employee from "../models/employee.model.js";
import MenuItem from "../models/menuItem.model.js";
import Orders from "../models/orders.model.js";
import Table from "../models/table.model.js";

class DatabaseManager {
  constructor() {
    this.connections = new Map();
    this.mainConnection = null;
  }

  async connectToMain(baseUrl) {
    try {
      if (!this.mainConnection) {
        this.mainConnection = mongoose.connect(baseUrl);
      }
      return this.mainConnection;
    } catch (error) {
      console.error("Main database connection error:", error);
      throw error;
    }
  }

  async createRestaurantDB(restaurantData, baseUrl, options) {
    try {
      const dbName = restaurantData.restaurantName
        .toLowerCase()
        .replace(/\s+/g, "-");
      const databaseUrl = `${baseUrl}/${dbName}${options}`;

      const connection = mongoose.createConnection(databaseUrl);
      await this.initializeRestaurantDB(connection, restaurantData);
      return databaseUrl;
    } catch (error) {
      console.error("Failed to create restaurant database:", error);
      throw error;
    }
  }

  async initializeRestaurantDB(connection, restaurantData) {
    try {
      const EmployeeModel = connection.model("Employee", Employee.schema);
      const employee = new EmployeeModel({
        employee: restaurantData.restaurantName,
        email: restaurantData.email,
        password: restaurantData.password,
        position: "admin",
      });
      await employee.save();
    } catch (error) {
      console.error(
        `Error initializing collection for ${Model.modelName}:`,
        error
      );
    }
  }

  async connectToRestaurantDB(restaurantId) {
    try {
      if (this.connections.has(restaurantId)) {
        return this.connections.get(restaurantId);
      }

      const restaurant = await Restaurant.findById(restaurantId);
      if (!restaurant) {
        throw new Error("Restaurant not found");
      }

      const connection = mongoose.createConnection(restaurant.databaseUrl);

      // Initialize models for this connection
      this.initModels(connection);
      this.connections.set(restaurantId, connection);

      return connection;
    } catch (error) {
      console.error("Restaurant database connection error:", error);
      throw error;
    }
  }

  initModels(connection) {
    // Reference your existing models

    const UserModel = connection.model("User", User.schema);
    const EmployeeModel = connection.model("Employee", Employee.schema);
    const MenuItemModel = connection.model("MenuItem", MenuItem.schema);
    const OrdersModel = connection.model("Order", Orders.schema);
    const TableModel = connection.model("Table", Table.schema);

    return { UserModel, EmployeeModel, MenuItemModel, OrdersModel, TableModel };
  }
}

export const dbManager = new DatabaseManager();
