import mongoose from "mongoose";
import User from "../models/user.model.js";

export const checkId = (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(404).send(`The id ${id} is not valid`);
  }
  next();
};

export const checkUser = async (req, res, next) => {
  const { id } = req.params;
  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
};

export const checkBeforeCreate = async (req, res, next) => {
  try {
    const { username, email } = req.body;
    if (typeof username !== "string" || typeof email !== "string") {
      return res.status(400).json({ message: "Invalid username or email" });
    }
    const user = await User.findOne({
      username,
    });
    const userEmail = await User.findOne({ email });
    if (user || userEmail) {
      return res.status(409).json({ message: "User already exists" });
    }
    next();
  } catch (error) {
    next(error);
  }
};
