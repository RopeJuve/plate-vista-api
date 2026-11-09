import { randomUUID } from "node:crypto";
import Payment, { SIGNATURE_STATUSES } from "../payments/payment.model.js";
import Restaurant from "../restaurants/restaurant.model.js";
import { getBillLines } from "../ordering/order.service.js";
import { centsToDecimal, totalsByVat } from "../payments/money.js";
import { captureException, logger } from "../../shared/logger.js";
import { FiskalyError } from "./fiskaly.client.js";
import { fiskaly, isTseActive } from "./tse.service.js";

// Signs each payment as its own Kassenbeleg transaction at the restaurant's
// TSE (ADR-0003), after the reply and on the Render server (ADR-0005). The
// payment itself never changes here; only its `tse` part does.

export const LOCK_MS = 60_000;
// After this many failures only a person retries (#29).
export const MAX_AUTO_RETRIES = 20;
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const SIGNABLE = SIGNATURE_STATUSES.filter((status) => status !== "SIGNED");

// What the internal channel can ask Render to sign.
export const SIGN_KINDS = Object.freeze({ PAYMENT: "PAYMENT" });

// 30 s, 1 m, 2 m … capped at 30 m, for the n-th failure in a row.
export const backoffMs = (failures) =>
  Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);

// A signing problem on our side. A permanent one cannot be fixed by trying
// again, so automatic retries stop at once and a person has to look (#29).
class SigningError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = "SigningError";
    this.permanent = permanent;
  }
}

// The bill's lines by VAT rate, built the same way as the guest's Receipt,
// so the signed Kassenbeleg and the Receipt always agree (ADR-0003/0004).
const amountsPerVatRate = async (payment) => {
  const totals = totalsByVat(await getBillLines(payment.restaurantId, payment.sessionId));
  const grossCents = totals.reduce((sum, rate) => sum + rate.grossCents, 0);
  if (grossCents !== payment.amountCents) {
    throw new SigningError(
      `bill lines total ${grossCents} cents but the payment is ${payment.amountCents}`,
      { permanent: true }
    );
  }
  return totals.map((rate) => ({ vat_rate: rate.vatRate, amount: centsToDecimal(rate.grossCents) }));
};

const receiptSchema = async (payment) => ({
  standard_v1: {
    receipt: {
      receipt_type: "RECEIPT",
      amounts_per_vat_rate: await amountsPerVatRate(payment),
      amounts_per_payment_type: [
        {
          payment_type: payment.method === "CASH" ? "CASH" : "NON_CASH",
          amount: centsToDecimal(payment.amountCents),
        },
      ],
    },
  },
});

const fromUnix = (seconds) => (seconds == null ? undefined : new Date(Number(seconds) * 1000));

// The text kept in `tse.lastError`: short, and never a PIN, PUK or secret
// (fiskaly's messages carry none).
const lastErrorText = (error) => {
  const text =
    error instanceof FiskalyError
      ? `fiskaly ${error.status}${error.code ? ` ${error.code}` : ""}: ${error.message}`
      : error?.message || String(error);
  return text.slice(0, 500);
};

// Field names inside the payment's `tse` part, for $set / $unset.
const tseFields = (fields) =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [`tse.${key}`, value]));

// Takes the payment for this signer if nobody else is signing it and it is
// still under the automatic retry limit. The lock time it sets is this
// signer's token: every later write checks it, so a signer whose lock ran
// out can never overwrite what the next one saved.
const claim = (paymentId) => {
  const now = new Date();
  return Payment.findOneAndUpdate(
    {
      _id: paymentId,
      "tse.status": { $in: SIGNABLE },
      "tse.retryCount": { $not: { $gte: MAX_AUTO_RETRIES } },
      $or: [{ "tse.lockedUntil": null }, { "tse.lockedUntil": { $lt: now } }],
    },
    { $set: { "tse.lockedUntil": new Date(now.getTime() + LOCK_MS) } },
    { new: true }
  )
    .setOptions({ skipTenant: true })
    .lean();
};

// Signs one payment. Returns the payment's stored state afterwards, or null
// when it was not there to sign (signed already, another signer has it, past
// the retry limit, or the lock ran out before we could save).
// fiskaly errors are recorded on the payment, never thrown.
export const signPayment = async (paymentId) => {
  const payment = await claim(paymentId);
  if (!payment) return null;
  const ours = {
    _id: payment._id,
    restaurantId: payment.restaurantId,
    "tse.lockedUntil": payment.tse.lockedUntil,
  };
  const ids = { restaurantId: String(payment.restaurantId), paymentId: String(payment._id) };
  const tse = { ...payment.tse };
  const saveOutcome = async (update) => {
    const saved = await Payment.findOneAndUpdate(ours, update, { new: true }).lean();
    if (!saved) logger.warn(ids, "payment signing lost its lock; the newer signer's result stands");
    return saved;
  };
  const saveTxId = async (txId) => {
    const { matchedCount } = await Payment.updateOne(ours, { $set: tseFields({ txId }) });
    if (!matchedCount) throw new SigningError("the signing lock ran out before the transaction was saved");
  };

  try {
    const restaurant = await Restaurant.findById(payment.restaurantId).select("tse").lean();
    const { tssId, clientId } = restaurant?.tse || {};
    if (!isTseActive(restaurant) || !tssId || !clientId) {
      throw new SigningError("the restaurant's TSE is not active");
    }
    const schema = await receiptSchema(payment);
    const client = fiskaly();

    // The transaction id is saved before fiskaly hears it, and fiskaly is
    // asked where it got to, so a run that stopped half way is picked up.
    // A transaction that ended CANCELLED can't be finished: start a new one.
    let tx = tse.txId ? await client.getTx(tssId, tse.txId) : null;
    if (!tse.txId || tx?.state === "CANCELLED") {
      tse.txId = randomUUID();
      tx = null;
      await saveTxId(tse.txId);
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

    return await saveOutcome({
      $set: tseFields({
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
      $unset: tseFields({ lockedUntil: 1, lastError: 1, nextAttemptAt: 1 }),
    });
  } catch (error) {
    const permanent = error instanceof SigningError && error.permanent;
    const retryCount = permanent ? MAX_AUTO_RETRIES : (payment.tse?.retryCount || 0) + 1;
    const fields = {
      ...ids,
      retryCount,
      permanent,
      status: error?.status,
      code: error?.code,
      fiskalyRequestId: error?.requestId,
      reason: lastErrorText(error),
    };
    if (permanent) logger.error(fields, "payment signing failed for good; a person has to look");
    else logger.warn(fields, "payment signing failed");
    if (permanent || (!(error instanceof FiskalyError) && !(error instanceof SigningError))) {
      captureException(error);
    }
    return saveOutcome({
      $set: tseFields({
        status: "FAILED",
        lastError: lastErrorText(error),
        retryCount,
        nextAttemptAt: new Date(Date.now() + backoffMs(retryCount)),
      }),
      $unset: tseFields({ lockedUntil: 1 }),
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
