import express from "express";
import { authLimiter } from "../../../middlewares/rateLimiters.js";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { checkId, requireAuth, requireRole, requireSelfOrAdmin } from "./auth.middleware.js";
import { createUser, deleteUser, getUser, listUsers, updateUser } from "./staff.service.js";

const userRouter = express.Router();

userRouter.get("/", requireAuth, requireRole("admin"), asyncRoute(async (req, res) => {
  res.status(200).json(await listUsers(req.query));
}));

userRouter.post("/", authLimiter, asyncRoute(async (req, res) => {
  res.status(201).json(await createUser(req.body));
}));

userRouter.get("/:id", checkId, requireAuth, requireSelfOrAdmin, asyncRoute(async (req, res) => {
  res.status(200).json(await getUser(req.params.id));
}));

userRouter.put("/:id", checkId, requireAuth, requireSelfOrAdmin, asyncRoute(async (req, res) => {
  res.status(200).json(await updateUser(req.params.id, req.body));
}));

userRouter.delete("/:id", checkId, requireAuth, requireRole("admin"), asyncRoute(async (req, res) => {
  await deleteUser(req.params.id);
  res.status(200).json({ message: "User deleted successfully" });
}));

export default userRouter;
