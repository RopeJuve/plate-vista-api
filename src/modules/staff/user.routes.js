import express from "express";
import { authLimiter } from "../../shared/rateLimiters.js";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { checkId, requireAuth, requireSelf } from "./auth.middleware.js";
import { createUser, deleteUser, getUser, updateUser } from "./staff.service.js";

const userRouter = express.Router();

userRouter.post("/", authLimiter, asyncRoute(async (req, res) => {
  res.status(201).json(await createUser(req.body));
}));

userRouter.get("/:id", checkId, requireAuth, requireSelf, asyncRoute(async (req, res) => {
  res.status(200).json(await getUser(req.params.id));
}));

userRouter.put("/:id", checkId, requireAuth, requireSelf, asyncRoute(async (req, res) => {
  res.status(200).json(await updateUser(req.params.id, req.body));
}));

userRouter.delete("/:id", checkId, requireAuth, requireSelf, asyncRoute(async (req, res) => {
  await deleteUser(req.params.id);
  res.status(200).json({ message: "User deleted successfully" });
}));

export default userRouter;
