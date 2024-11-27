import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import multer from "multer";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "plate-vista-menu-items",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [
      { quality: "auto", fetch_format: "auto" },
      { width: 500, height: 500, crop: "fill", gravity: "auto" },
    ],
  },
});

export const upload = multer({ storage: storage });
