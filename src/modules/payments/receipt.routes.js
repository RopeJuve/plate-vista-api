import express from "express";
import { asyncRoute } from "../../shared/asyncRoute.js";
import { receiptLimiter } from "../../shared/rateLimiters.js";
import { getReceipt } from "./receipt.service.js";

const receiptRouter = express.Router();

// Public: guests open their receipt by link or QR code, without signing in.
receiptRouter.get(
  "/:receiptToken",
  receiptLimiter,
  asyncRoute(async (req, res) => {
    res.status(200).json(await getReceipt(req.params.receiptToken));
  })
);

export default receiptRouter;
