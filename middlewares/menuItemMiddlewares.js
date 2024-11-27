import { v2 as cloudinary } from "cloudinary";

export const checkItem = async (req, res, next) => {
  const { id } = req.params;
  const { dbConnection } = req;
  try {
    const item = await dbConnection.model("MenuItem").findById(id);
    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }
    req.item = item;
    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const checkBeforeCreate = async (req, res, next) => {
  const { dbConnection } = req;
  try {
    const { title } = req.body;
    const item = await dbConnection.model("MenuItem").findOne({
      title,
    });
    if (item) {
      if (req.file && req.file.path) {
        await cloudinary.uploader.destroy(req.file.filename);
      }
      return res.status(409).json({ message: "Item already exists" });
    }
    next();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
