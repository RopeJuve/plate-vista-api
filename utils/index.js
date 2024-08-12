import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();


export const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
};

export const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

export const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      username: user.username,
      email: user.email,
    },
    process.env.SECRET,
    { expiresIn: "1h" }
  );
};

export const verifyToken = (token) => {
  return jwt.verify(token, process.env.SECRET);
};
export const sanitizedUsers = (users) => {
  return users.map((user) => {
    const { password, __v, ...rest } = user._doc;
    return rest;
  });
};

export const sanitizedUser = (user) => {
  const { password, __v, ...rest } = user._doc;
  return rest;
};
