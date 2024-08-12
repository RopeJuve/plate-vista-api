import bcrypt from "bcrypt";

export const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
};

export const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
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
