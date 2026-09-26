import { timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import { deliverLocal } from "../../realtime/events.js";

const emitSchema = z.object({
  restaurantId: z.string().regex(/^[a-f\d]{24}$/i),
  sessionId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  fanout: z.boolean().optional(),
  audience: z.enum(["staff"]).optional(),
  message: z.object({
    type: z.literal("event"),
    event: z.string().min(1),
    data: z.unknown(),
  }),
});

const secretsMatch = (header) => {
  const expected = process.env.INTERNAL_SECRET || "";
  const received = typeof header === "string" ? header : "";
  if (!expected || !received) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

const internalRouter = express.Router();

internalRouter.post("/emit", (req, res) => {
  if (!secretsMatch(req.get("x-internal-secret"))) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const parsed = emitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ code: "VALIDATION", message: "Invalid payload" });
  }
  deliverLocal(parsed.data);
  return res.status(202).json({ ok: true });
});

export default internalRouter;
