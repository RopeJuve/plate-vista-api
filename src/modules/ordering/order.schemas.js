import { z } from "zod";
import { ORDER_STATUSES } from "./order.transitions.js";

const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, "must be a valid id");

export const orderItemSchema = z.object({
  productId: objectId,
  quantity: z
    .number({ invalid_type_error: "quantity must be a positive integer less than 100" })
    .int("quantity must be a positive integer less than 100")
    .positive("quantity must be a positive integer less than 100")
    .lt(100, "quantity must be a positive integer less than 100"),
  notes: z.string().max(280).optional(),
});

export const createOrderSchema = z.object({
  clientOrderId: z.string().uuid("clientOrderId must be a UUID"),
  items: z.array(orderItemSchema).min(1).max(50),
  sessionId: objectId.optional(),
  tableId: objectId.optional(),
});

export const updateOrderSchema = z.object({
  orderId: objectId,
  items: z.array(orderItemSchema).min(1).max(50),
});

export const statusOrderSchema = z.object({
  orderId: objectId,
  status: z.string().refine((value) => ORDER_STATUSES.includes(value), "Invalid order status"),
});

export const cancelOrderSchema = z.object({
  orderId: objectId,
  reason: z.string().max(500).optional(),
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
