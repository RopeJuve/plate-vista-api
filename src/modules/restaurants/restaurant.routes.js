import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { requireAuth, requireRole, requireTenant } from "../staff/auth.middleware.js";
import { signLogoUpload } from "../../shared/cloudinary.js";
import { getLegalDetails, updateLegalDetails } from "./legal.js";
import { getProfile, getPublicProfile, updateProfile } from "./profile.js";

const restaurantRouter = express.Router();
// "admin" also admits the owner.
const manage = [requireAuth, requireRole("admin"), requireTenant];

restaurantRouter.get("/legal", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json(await getLegalDetails(req.tenant.restaurantId));
}));

restaurantRouter.put("/legal", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json(await updateLegalDetails(req.tenant.restaurantId, req.body));
}));

restaurantRouter.get("/profile", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json(await getProfile(req.tenant.restaurantId));
}));

restaurantRouter.put("/profile", ...manage, asyncRoute(async (req, res) => {
  res.status(200).json(await updateProfile(req.tenant.restaurantId, req.body));
}));

// Responds with what the browser needs to upload the logo to Cloudinary.
restaurantRouter.post("/profile/logo-upload-signature", ...manage, (req, res) => {
  res.status(200).json(signLogoUpload(req.tenant.restaurantId));
});

export default restaurantRouter;

// Mounted next to the public menu: guests read it without signing in.
export const publicRestaurantRouter = express.Router();

publicRestaurantRouter.get("/:slug/profile", asyncRoute(async (req, res) => {
  const profile = await getPublicProfile(req.params.slug);
  res.set("Cache-Control", "public, max-age=60");
  res.status(200).json(profile);
}));
