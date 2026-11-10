import mongoose from "mongoose";
import Order from "./order.model.js";
import { linesOnActiveTickets, ticketsOf } from "./tickets.js";
import { centsToDecimal } from "../payments/money.js";
import { captureException, logger } from "../../shared/logger.js";
import {
  failureFields,
  finishTransaction,
  fromUnix,
  isExpected,
  isPermanent,
  lastErrorText,
  LOCK_MS,
  MAX_AUTO_RETRIES,
  SigningError,
  signingDevice,
} from "../tse/transaction.js";

// Signs each order as its own short Bestellung transaction at the
// restaurant's TSE, and every later change to a signed order (a cancelled
// ticket, an edit) as a correction: another Bestellung with the difference,
// removed lines as negative quantities (ADR-0003). It runs after the reply
// and on the Render server (ADR-0005); the order itself never changes here,
// only its `tse` part and its `tseCorrections`.
//
// What is signed is kept on the order (`tse.lines`, each correction's
// `lines`), so the next correction is always the difference between what the
// TSE has recorded and what the order holds now.

const SIGNABLE = ["PENDING", "FAILED"];

// The lines a Bestellung records: those on tickets still being worked, one
// per menu item title and unit price.
export const linesToSign = (order) => {
  const merged = new Map();
  for (const line of linesOnActiveTickets(order.items || [], ticketsOf(order))) {
    const key = `${line.unitPriceCents}:${line.title}`;
    const entry = merged.get(key) || { text: line.title, unitPriceCents: line.unitPriceCents, quantity: 0 };
    entry.quantity += line.quantity;
    merged.set(key, entry);
  }
  return [...merged.values()];
};

const keyOf = (line) => `${line.unitPriceCents}:${line.text}`;

// What the TSE has recorded for the order: its Bestellung plus every
// correction, signed or still waiting.
const recordedLines = (order) => {
  const net = new Map();
  const add = (lines = []) =>
    lines.forEach((line) => {
      const entry = net.get(keyOf(line)) || { text: line.text, unitPriceCents: line.unitPriceCents, quantity: 0 };
      entry.quantity += line.quantity;
      net.set(keyOf(line), entry);
    });
  add(order.tse?.lines);
  (order.tseCorrections || []).forEach((correction) => add(correction.lines));
  return net;
};

// The correction that brings the TSE's record in line with the order as it
// is now, or null when nothing needs correcting (or nothing is signed yet: an
// order waiting for its signature is simply signed as it is then).
export const correctionFor = (order, { station } = {}) => {
  if (order.tse?.status !== "SIGNED") return null;
  const recorded = recordedLines(order);
  const now = new Map(linesToSign(order).map((line) => [keyOf(line), line]));
  const lines = [...new Set([...recorded.keys(), ...now.keys()])]
    .map((key) => {
      const line = now.get(key) || recorded.get(key);
      const quantity = (now.get(key)?.quantity || 0) - (recorded.get(key)?.quantity || 0);
      return { text: line.text, unitPriceCents: line.unitPriceCents, quantity };
    })
    .filter((line) => line.quantity !== 0);
  if (lines.length === 0) return null;
  return { ...(station ? { station } : {}), status: "PENDING", lines, retryCount: 0 };
};

// An order cancelled whole before its Bestellung was started at fiskaly has
// nothing to sign. Once a transaction was started it is finished and then
// corrected, so the TSE's record has no gap.
export const dropsSignature = (order) =>
  Boolean(order.tse) && order.tse.status !== "SIGNED" && !order.tse.txId && linesToSign(order).length === 0;

// fiskaly reads every line item value as a string, the quantity included;
// a number is rejected with E_PARSER (#58).
export const orderSchema = (lines) => ({
  standard_v1: {
    order: {
      line_items: lines.map((line) => ({
        quantity: String(line.quantity),
        text: line.text,
        price_per_unit: centsToDecimal(line.unitPriceCents),
      })),
    },
  },
});

const signable = (maxRetries) => ({
  status: { $in: SIGNABLE },
  retryCount: { $not: { $gte: maxRetries } },
});

const prefixed = (prefix, fields) =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [`${prefix}.${key}`, value]));

// Takes the order for this signer if nobody else is signing it and its
// Bestellung or one of its corrections waits for a signature, under the
// automatic retry limit. The lock time it sets is this signer's token.
const claim = (orderId) => {
  const now = new Date();
  const waiting = signable(MAX_AUTO_RETRIES);
  return Order.findOneAndUpdate(
    {
      _id: orderId,
      $and: [
        {
          $or: [
            prefixed("tse", waiting),
            { "tse.status": "SIGNED", tseCorrections: { $elemMatch: waiting } },
          ],
        },
        { $or: [{ "tse.lockedUntil": null }, { "tse.lockedUntil": { $lt: now } }] },
      ],
    },
    { $set: { "tse.lockedUntil": new Date(now.getTime() + LOCK_MS) } },
    { new: true }
  )
    .setOptions({ skipTenant: true })
    .lean();
};

const signedFields = (tx) => ({
  status: "SIGNED",
  revision: tx.revision,
  txNumber: tx.number,
  timeEnd: fromUnix(tx.time_end),
  signatureCounter: tx.signature?.counter,
});

// Signs one order's Bestellung and then its waiting corrections, in turn,
// stopping at the first failure. Returns the order's stored state afterwards,
// or null when there was nothing to sign (signed already, no `tse`, another
// signer has it, past the retry limit). fiskaly errors are recorded on the
// order, never thrown.
export const signOrder = async (orderId) => {
  const claimed = await claim(orderId);
  if (!claimed) return null;
  const ours = {
    _id: claimed._id,
    restaurantId: claimed.restaurantId,
    "tse.lockedUntil": claimed.tse.lockedUntil,
  };
  const ids = { restaurantId: String(claimed.restaurantId), orderId: String(claimed._id) };
  const lockLost = () => new SigningError("the signing lock ran out before the transaction was saved");
  const save = async (filter, update) => {
    const { matchedCount } = await Order.updateOne({ ...ours, ...filter }, update);
    if (!matchedCount) throw lockLost();
  };
  const read = () => Order.findOne(ours).lean();
  const stored = () => Order.findOne({ _id: claimed._id, restaurantId: claimed.restaurantId }).lean();
  const recordFailure = async (error, { prefix, filter, retryCount, what }) => {
    const permanent = isPermanent(error);
    const failed = failureFields(error, retryCount);
    const fields = {
      ...ids,
      retryCount: failed.retryCount,
      permanent,
      status: error?.status,
      code: error?.code,
      fiskalyRequestId: error?.requestId,
      reason: lastErrorText(error),
    };
    if (permanent) logger.error(fields, `${what} signing failed for good; a person has to look`);
    else logger.warn(fields, `${what} signing failed`);
    if (permanent || !isExpected(error)) captureException(error);
    const { matchedCount } = await Order.updateOne({ ...ours, ...filter }, { $set: prefixed(prefix, failed) });
    if (!matchedCount) logger.warn(ids, "order signing lost its lock; the newer signer's result stands");
  };

  let order = claimed;
  let device;
  let dropped = false;
  try {
    if (dropsSignature(order)) {
      await save({}, { $unset: { tse: 1 } });
      dropped = true;
    } else if (order.tse.status !== "SIGNED") {
      try {
        device = await signingDevice(order.restaurantId);
        // The lines go with the transaction id: a transaction started
        // earlier is finished with what it was started for.
        let lines = order.tse.txId ? order.tse.lines || [] : linesToSign(order);
        const { tx } = await finishTransaction({
          ...device,
          txId: order.tse.txId,
          saveTxId: async (txId) => {
            lines = linesToSign(order);
            await save({}, { $set: { "tse.txId": txId, "tse.lines": lines } });
          },
          schema: () => orderSchema(lines),
        });
        await save(
          {},
          {
            $set: prefixed("tse", { ...signedFields(tx), lines }),
            $unset: { "tse.lastError": 1, "tse.nextAttemptAt": 1 },
          }
        );
      } catch (error) {
        await recordFailure(error, { prefix: "tse", filter: {}, retryCount: order.tse.retryCount, what: "order" });
        order = null;
      }
      // A cancel or edit that landed while the Bestellung was being signed
      // saw it unsigned and left the correcting to us. Pushed only if the
      // order is still as read; a change in between is read again.
      while (order) {
        order = await read();
        if (!order) throw lockLost();
        const correction = correctionFor(order);
        if (!correction) break;
        const { matchedCount } = await Order.updateOne(
          { ...ours, rev: order.rev },
          { $push: { tseCorrections: correction } }
        );
        if (matchedCount) {
          order = await read();
          if (!order) throw lockLost();
          break;
        }
      }
    }

    for (const correction of order?.tseCorrections || []) {
      if (!SIGNABLE.includes(correction.status) || correction.retryCount >= MAX_AUTO_RETRIES) continue;
      const at = { "tseCorrections._id": correction._id };
      try {
        device ??= await signingDevice(order.restaurantId);
        const { txId, tx } = await finishTransaction({
          ...device,
          txId: correction.txId,
          saveTxId: (txId) => save(at, { $set: { "tseCorrections.$.txId": txId } }),
          schema: () => orderSchema(correction.lines),
        });
        await save(at, {
          $set: prefixed("tseCorrections.$", { status: "SIGNED", txId, txNumber: tx.number }),
          $unset: { "tseCorrections.$.lastError": 1, "tseCorrections.$.nextAttemptAt": 1 },
        });
      } catch (error) {
        await recordFailure(error, {
          prefix: "tseCorrections.$",
          filter: at,
          retryCount: correction.retryCount,
          what: "order correction",
        });
        break;
      }
    }
  } catch (error) {
    logger.error({ ...ids, err: error }, "order signing failed");
    if (!isExpected(error)) captureException(error);
  } finally {
    await Order.updateOne(ours, { $unset: { "tse.lockedUntil": 1 } }).catch((error) => {
      logger.warn({ ...ids, err: error }, "order signing could not release its lock");
    });
  }
  return dropped ? null : stored();
};

// The orders the sweep should try now: a Bestellung or a correction waiting
// or failed, due, and not past the automatic retry limit. Across restaurants.
export const findDueOrders = ({ now = new Date(), limit = 50, maxRetries = MAX_AUTO_RETRIES } = {}) => {
  const due = { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] };
  const waiting = { ...signable(maxRetries), ...due };
  return Order.find({
    $or: [
      {
        ...prefixed("tse", signable(maxRetries)),
        $or: [{ "tse.nextAttemptAt": null }, { "tse.nextAttemptAt": { $lte: now } }],
      },
      { "tse.status": "SIGNED", tseCorrections: { $elemMatch: waiting } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select("_id")
    .setOptions({ skipTenant: true })
    .lean();
};

// Failed signatures of one restaurant's orders, for the owner (#29): a
// failed Bestellung and every failed correction count on their own.
export const countFailedOrderSignatures = async (restaurantId) => {
  const restaurant = new mongoose.Types.ObjectId(String(restaurantId));
  const [bestellungen, corrections] = await Promise.all([
    Order.countDocuments({ restaurantId: restaurant, "tse.status": "FAILED" }),
    Order.aggregate([
      { $match: { restaurantId: restaurant, "tseCorrections.status": "FAILED" } },
      { $unwind: "$tseCorrections" },
      { $match: { "tseCorrections.status": "FAILED" } },
      { $count: "count" },
    ]),
  ]);
  return bestellungen + (corrections[0]?.count || 0);
};

const centsOf = (lines = []) => lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);

// Each failed Bestellung or correction as `{ id, tableId, at, amountCents,
// error, retryCount }`; a correction carries its order's id and is as old as
// the correction itself, its amount negative for what was taken off.
export const listFailedOrderSignatures = async (restaurantId) => {
  const orders = await Order.find({
    restaurantId,
    $or: [{ "tse.status": "FAILED" }, { "tseCorrections.status": "FAILED" }],
  })
    .select("tableId createdAt items tickets tse.status tse.lines tse.lastError tse.retryCount tseCorrections")
    .lean();
  const failed = [];
  for (const order of orders) {
    const entry = (at, amountCents, { lastError, retryCount }) =>
      failed.push({ id: order._id, tableId: order.tableId, at, amountCents, error: lastError, retryCount });
    if (order.tse?.status === "FAILED") {
      entry(order.createdAt, centsOf(order.tse.lines || linesToSign(order)), order.tse);
    }
    for (const correction of order.tseCorrections || []) {
      if (correction.status === "FAILED") entry(correction.createdAt || correction._id.getTimestamp(), centsOf(correction.lines), correction);
    }
  }
  return failed;
};

// Puts a failed order's Bestellung and failed corrections back under the
// automatic retry limit. False when the order has nothing failed.
export const resetFailedOrder = async (restaurantId, orderId) => {
  const order = await Order.findOne({
    _id: orderId,
    restaurantId,
    $or: [{ "tse.status": "FAILED" }, { "tseCorrections.status": "FAILED" }],
  })
    .select("tse.status tseCorrections.status")
    .lean();
  if (!order) return false;
  const $set = {};
  if (order.tse?.status === "FAILED") $set["tse.retryCount"] = 0;
  const correctionFailed = (order.tseCorrections || []).some((entry) => entry.status === "FAILED");
  if (correctionFailed) $set["tseCorrections.$[failed].retryCount"] = 0;
  await Order.updateOne(
    { _id: orderId, restaurantId },
    { $set },
    correctionFailed ? { arrayFilters: [{ "failed.status": "FAILED" }] } : {}
  );
  return true;
};

// Whether everything of the order the TSE has to record is signed.
export const isOrderSigned = async (restaurantId, orderId) => {
  const order = await Order.findOne({ _id: orderId, restaurantId }).select("tse.status tseCorrections.status").lean();
  if (!order?.tse) return Boolean(order);
  return order.tse.status === "SIGNED" && (order.tseCorrections || []).every((entry) => entry.status === "SIGNED");
};
