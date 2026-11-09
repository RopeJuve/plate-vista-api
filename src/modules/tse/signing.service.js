import { randomUUID } from "node:crypto";
import Payment from "../payments/payment.model.js";
import Restaurant from "../restaurants/restaurant.model.js";
import { VAT_RATES } from "../categories/category.model.js";
import { getSessionBill } from "../ordering/order.service.js";
import { captureException, logger } from "../../shared/logger.js";
import { FiskalyError } from "./fiskaly.client.js";
import { fiskaly } from "./tse.service.js";

// Signs each payment as its own Kassenbeleg transaction at the restaurant's
// TSE (ADR-0003), after the reply and on the Render server (ADR-0005). The
// payment itself never changes here; only its `tse` part does.

export const LOCK_MS = 60_000;
// After this many failures only a person retries (#29).
export const MAX_AUTO_RETRIES = 20;
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const SIGNABLE = ["PENDING", "FAILED"];

// 30 s, 1 m, 2 m … capped at 30 m, for the n-th failure in a row.
export const backoffMs = (failures) =>
  Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);

// fiskaly takes amounts as "12.50".
const amount = (cents) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

class SigningError extends Error {}

// The bill's lines by VAT rate, leaving out cancelled orders and tickets the
// same way the bill's total does.
const amountsPerVatRate = async (payment) => {
  const bill = await getSessionBill({ restaurantId: payment.restaurantId }, payment.sessionId);
  const byRate = new Map();
  for (const order of bill.orders) {
    const active = new Set(
      order.tickets.filter((ticket) => ticket.status !== "cancelled").map((ticket) => ticket.station)
    );
    for (const line of order.items) {
      if (!active.has(line.station)) continue;
      // Lines from before categories had a rate are counted at the normal rate.
      const rate = line.vatRate || "NORMAL";
      byRate.set(rate, (byRate.get(rate) || 0) + line.lineTotalCents);
    }
  }
  const total = [...byRate.values()].reduce((sum, cents) => sum + cents, 0);
  if (total !== payment.amountCents) {
    throw new SigningError(`bill lines total ${total} cents but the payment is ${payment.amountCents}`);
  }
  return VAT_RATES.filter((rate) => byRate.has(rate)).map((rate) => ({
    vat_rate: rate,
    amount: amount(byRate.get(rate)),
  }));
};

const receiptSchema = async (payment) => ({
  standard_v1: {
    receipt: {
      receipt_type: "RECEIPT",
      amounts_per_vat_rate: await amountsPerVatRate(payment),
      amounts_per_payment_type: [
        {
          payment_type: payment.method === "CASH" ? "CASH" : "NON_CASH",
          amount: amount(payment.amountCents),
        },
      ],
    },
  },
});

const fromUnix = (seconds) => (seconds == null ? undefined : new Date(Number(seconds) * 1000));

const describe = (error) => {
  const text =
    error instanceof FiskalyError
      ? `fiskaly ${error.status}${error.code ? ` ${error.code}` : ""}: ${error.message}`
      : error?.message || String(error);
  return text.slice(0, 500);
};

const prefixed = (fields) =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [`tse.${key}`, value]));

// Takes the payment for this signer if nobody else is signing it.
const claim = (paymentId) => {
  const now = new Date();
  return Payment.findOneAndUpdate(
    {
      _id: paymentId,
      "tse.status": { $in: SIGNABLE },
      $or: [{ "tse.lockedUntil": null }, { "tse.lockedUntil": { $lt: now } }],
    },
    { $set: { "tse.lockedUntil": new Date(now.getTime() + LOCK_MS) } },
    { new: true }
  )
    .setOptions({ skipTenant: true })
    .lean();
};

// Signs one payment. Returns the payment's stored state afterwards, or null
// when it was not there to sign (signed already, or another signer has it).
// fiskaly errors are recorded on the payment, never thrown.
export const signPayment = async (paymentId) => {
  const payment = await claim(paymentId);
  if (!payment) return null;
  const where = { _id: payment._id, restaurantId: payment.restaurantId };
  const tse = { ...payment.tse };
  const finish = (update) => Payment.findOneAndUpdate(where, update, { new: true }).lean();

  try {
    const restaurant = await Restaurant.findById(payment.restaurantId).select("tse").lean();
    const { tssId, clientId, setupStep } = restaurant?.tse || {};
    if (setupStep !== "DONE" || !tssId || !clientId) throw new SigningError("the restaurant's TSE is not active");
    const schema = await receiptSchema(payment);
    const client = fiskaly();

    // The transaction id is saved before fiskaly hears it, and fiskaly is
    // asked where it got to, so a run that stopped half way is picked up.
    let tx = tse.txId ? await client.getTx(tssId, tse.txId) : null;
    if (!tse.txId) {
      tse.txId = randomUUID();
      await Payment.updateOne(where, { $set: prefixed({ txId: tse.txId }) });
    }
    if (!tx) tx = await client.startTx(tssId, tse.txId, { clientId });
    if (tx.state === "ACTIVE") {
      tx = await client.finishTx(tssId, tse.txId, {
        clientId,
        schema,
        revision: Number(tx.revision || 1) + 1,
      });
    }
    if (tx.state !== "FINISHED") throw new SigningError(`the fiskaly transaction is ${tx.state}`);

    return await finish({
      $set: prefixed({
        status: "SIGNED",
        revision: tx.revision,
        txNumber: tx.number,
        timeStart: fromUnix(tx.time_start),
        timeEnd: fromUnix(tx.time_end),
        signatureValue: tx.signature?.value,
        signatureCounter: tx.signature?.counter,
        tssSerial: tx.tss_serial_number,
        clientSerial: tx.client_serial_number,
        qrCodeData: tx.qr_code_data,
      }),
      $unset: prefixed({ lockedUntil: 1, lastError: 1, nextAttemptAt: 1 }),
    });
  } catch (error) {
    const retryCount = (payment.tse?.retryCount || 0) + 1;
    logger.warn(
      {
        restaurantId: String(payment.restaurantId),
        paymentId: String(payment._id),
        retryCount,
        status: error?.status,
        code: error?.code,
        fiskalyRequestId: error?.requestId,
        reason: describe(error),
      },
      "payment signing failed"
    );
    if (!(error instanceof FiskalyError) && !(error instanceof SigningError)) captureException(error);
    return finish({
      $set: prefixed({
        status: "FAILED",
        lastError: describe(error),
        retryCount,
        nextAttemptAt: new Date(Date.now() + backoffMs(retryCount)),
      }),
      $unset: prefixed({ lockedUntil: 1 }),
    });
  }
};

// Signs after the current request has replied; a failure only logs, and the
// sweep tries again.
export const signPaymentLater = (paymentId) => {
  setImmediate(() => {
    signPayment(paymentId).catch((error) => {
      logger.error({ paymentId: String(paymentId), err: error }, "payment signing crashed");
      captureException(error);
    });
  });
};

// The payments the sweep should try now: waiting or failed, due, and not
// past the automatic retry limit. Across restaurants.
export const findDuePayments = ({ now = new Date(), limit = 50, maxRetries = MAX_AUTO_RETRIES } = {}) =>
  Payment.find({
    "tse.status": { $in: SIGNABLE },
    "tse.retryCount": { $not: { $gte: maxRetries } },
    $or: [{ "tse.nextAttemptAt": null }, { "tse.nextAttemptAt": { $lte: now } }],
  })
    .sort({ "tse.nextAttemptAt": 1, paidAt: 1 })
    .limit(limit)
    .select("_id")
    .setOptions({ skipTenant: true })
    .lean();
