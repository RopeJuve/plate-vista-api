import mongoose from "mongoose";

export const checkId = (req, res, next) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(404).send(`The id ${id} is not valid`);
  }
  next();
};

export const checkUser = async (req, res, next) => {
  const { id } = req.params;
  const { dbConnection } = req;
  try {
    const user = await dbConnection.model("User").findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    req.user = user;
    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const checkBeforeCreate = async (req, res, next) => {
  const { dbConnection } = req;
  try {
    const { username, email } = req.body;
    const user = await dbConnection.model("User").findOne({
      username,
    });
    const userEmail = await dbConnection.model("User").findOne({ email });
    if (user || userEmail) {
      return res.status(409).json({ message: "User already exists" });
    }
    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
