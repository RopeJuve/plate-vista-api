import mongoose from "mongoose";
import { ticketsOf } from "../modules/ordering/tickets.js";

const BATCH = 500;

// Gives every order saved before tickets existed one ticket for each station
// its lines go to, at the status the whole order had. Orders read fine without
// this (ticketsOf works them out); it stores the answer so every order has the
// same shape. Safe to run again: orders that already have tickets are skipped.
export const migrateTickets = async () => {
  const orders = mongoose.connection.db.collection("orders");
  const cursor = orders.find({
    "items.0": { $exists: true },
    $or: [{ tickets: { $exists: false } }, { tickets: { $size: 0 } }],
  });
  let ticketedOrders = 0;
  let ops = [];
  const flush = async () => {
    if (ops.length === 0) return;
    await orders.bulkWrite(ops);
    ticketedOrders += ops.length;
    ops = [];
  };
  for await (const order of cursor) {
    ops.push({
      updateOne: { filter: { _id: order._id }, update: { $set: { tickets: ticketsOf(order) } } },
    });
    if (ops.length === BATCH) await flush();
  }
  await flush();
  return { ticketedOrders };
};
