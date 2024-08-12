import User from "../models/user.model.js";
import { hashPassword, sanitizedUsers, sanitizedUser } from "../utils/index.js";

export const getUsers = async (req, res) => {
  try {
    const users = await User.find();
    const usersInfo = sanitizedUsers(users);
    res.status(200).json(usersInfo);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const createUser = async (req, res) => {
  const { username, email, password } = req.body;
  const hashedPassword = await hashPassword(password);
  try {
    const user = new User({
      username,
      email,
      password: hashedPassword,
    });
    await user.save();
    res.status(201).json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getUserById = async (req, res) => {
  res.status(200).json(sanitizedUser(req.user));
};

export const updateUser = async (req, res) => {
  const { id } = req.params;
  const updateBody = req.body;
  if (updateBody.password) {
    updateBody.password = await hashPassword(updateBody.password);
  }
  try {
    const updatedUser = await User.findByIdAndUpdate(id, updateBody, {
      new: true,
    });
    res.status(200).json(sanitizedUser(updatedUser));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    await User.findByIdAndDelete(id);
    res.status(200).json({ message: "User deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
