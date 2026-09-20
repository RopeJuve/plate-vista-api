import User from "../models/user.model.js";
import {
  hashPassword,
  sanitizedUsers,
  sanitizedUser,
  pick,
  parsePagination,
} from "../utils/index.js";

export const getUsers = async (req, res, next) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const [users, total] = await Promise.all([
      User.find().skip(skip).limit(limit),
      User.countDocuments(),
    ]);
    res.status(200).json({ users: sanitizedUsers(users), page, limit, total });
  } catch (err) {
    next(err);
  }
};

export const createUser = async (req, res, next) => {
  const { username, email, password } = req.body;
  try {
    const hashedPassword = await hashPassword(password);
    const user = new User({
      username,
      email,
      password: hashedPassword,
    });
    await user.save();
    res.status(201).json(sanitizedUser(user));
  } catch (err) {
    next(err);
  }
};

export const getUserById = async (req, res) => {
  res.status(200).json(sanitizedUser(req.user));
};

export const updateUser = async (req, res, next) => {
  const { id } = req.params;
  const updateBody = pick(req.body, ["username", "email", "password"]);
  try {
    if (updateBody.password) {
      updateBody.password = await hashPassword(updateBody.password);
    }
    const updatedUser = await User.findByIdAndUpdate(id, updateBody, {
      new: true,
      runValidators: true,
    });
    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(200).json(sanitizedUser(updatedUser));
  } catch (err) {
    next(err);
  }
};

export const deleteUser = async (req, res, next) => {
  const { id } = req.params;
  try {
    await User.findByIdAndDelete(id);
    res.status(200).json({ message: "User deleted successfully" });
  } catch (err) {
    next(err);
  }
};
