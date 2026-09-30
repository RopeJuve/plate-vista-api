import { z } from "zod";
import { ORDER_STATUSES } from "./order.transitions.js";
import { STATIONS } from "../categories/category.model.js";

const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, "must be a valid id");

export const MAX_ITEMS = 50;
export const MAX_QUANTITY = 99;
export const MAX_NOTES = 200;

export const orderItemSchema = z.object({
  productId: objectId,
  quantity: z
    .number({ invalid_type_error: "must be >= 1" })
    .int("must be >= 1")
    .min(1, "must be >= 1")
    .max(MAX_QUANTITY, "must be <= 99"),
  notes: z.string().max(MAX_NOTES, "must be at most 200 characters").optional(),
});

export const createOrderSchema = z.object({
  clientOrderId: z.string().uuid("clientOrderId must be a UUID"),
  items: z.array(orderItemSchema).min(1, "must contain at least 1 item").max(MAX_ITEMS, "must contain at most 50 items"),
  sessionId: objectId.optional(),
  tableId: objectId.optional(),
});

export const updateOrderSchema = z.object({
  orderId: objectId,
  items: z.array(orderItemSchema).min(1, "must contain at least 1 item").max(MAX_ITEMS, "must contain at most 50 items"),
});

// Without a station the message is about the whole order, as it was before
// tickets existed.
const station = z.enum(STATIONS, { error: "Station must be kitchen or bar" }).optional();

export const statusOrderSchema = z.object({
  orderId: objectId,
  status: z.string().refine((value) => ORDER_STATUSES.includes(value), "Invalid order status"),
  station,
});

export const cancelOrderSchema = z.object({
  orderId: objectId,
  reason: z.string().max(500).optional(),
  station,
});

export const inboundMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("order.create"),
    requestId: z.string().uuid("requestId must be a UUID"),
    payload: createOrderSchema,
  }),
  z.object({
    type: z.literal("order.update"),
    requestId: z.string().uuid("requestId must be a UUID"),
    payload: updateOrderSchema,
  }),
  z.object({
    type: z.literal("order.cancel"),
    requestId: z.string().uuid("requestId must be a UUID"),
    payload: cancelOrderSchema,
  }),
  z.object({
    type: z.literal("order.status"),
    requestId: z.string().uuid("requestId must be a UUID"),
    payload: statusOrderSchema,
  }),
]);
