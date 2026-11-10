import Payment, { SIGNATURE_STATUSES } from "../payments/payment.model.js";
import { getBillLines } from "../ordering/order.service.js";
import { findDueOrders, signOrder } from "../ordering/order.signing.js";
import { centsToDecimal, totalsByVat } from "../payments/money.js";
import { publishPaymentSigned, publishPaymentSignFailed } from "../payments/events.js";
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
} from "./transaction.js";

export { backoffMs, LOCK_MS, MAX_AUTO_RETRIES } from "./transaction.js";

// Signs each payment as its own Kassenbeleg transaction at the restaurant's
// TSE (ADR-0003), after the reply and on the Render server (ADR-0005). The
// payment itself never changes here; only its `tse` part does.

const SIGNABLE = SIGNATURE_STATUSES.filter((status) => status !== "SIGNED");

// What can be sent to be signed, as `{ kind, id }`: a payment, or an order
// with its corrections (src/modules/ordering/order.signing.js).
export const SIGN_KINDS = Object.freeze({ PAYMENT: "PAYMENT", ORDER: "ORDER" });

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
    const { tssId, clientId } = await signingDevice(payment.restaurantId);
    const schema = await receiptSchema(payment);
    const { tx } = await finishTransaction({
      tssId,
      clientId,
      txId: payment.tse.txId,
      saveTxId,
      schema: () => schema,
    });

    const signed = await saveOutcome({
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
    if (signed) publishPaymentSigned(signed);
    return signed;
  } catch (error) {
    const permanent = isPermanent(error);
    const failed = failureFields(error, payment.tse?.retryCount);
    const fields = {
      ...ids,
      retryCount: failed.retryCount,
      permanent,
      status: error?.status,
      code: error?.code,
      fiskalyRequestId: error?.requestId,
      reason: lastErrorText(error),
    };
    if (permanent) logger.error(fields, "payment signing failed for good; a person has to look");
    else logger.warn(fields, "payment signing failed");
    if (permanent || !isExpected(error)) captureException(error);
    const saved = await saveOutcome({
      $set: tseFields(failed),
      $unset: tseFields({ lockedUntil: 1 }),
    });
    if (saved) publishPaymentSignFailed(saved);
    return saved;
  }
};

// Signs a payment or an order, whichever the target names.
export const sign = ({ kind, id }) => {
  if (kind === SIGN_KINDS.PAYMENT) return signPayment(id);
  if (kind === SIGN_KINDS.ORDER) return signOrder(id);
  throw new Error(`Unknown signing kind ${kind}`);
};

// Signs after the current request has replied; a failure only logs, and the
// sweep tries again.
export const signLater = (target) => {
  setImmediate(() => {
    Promise.resolve()
      .then(() => sign(target))
      .catch((error) => {
        logger.error({ kind: target.kind, id: String(target.id), err: error }, "signing crashed");
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

// Everything the sweep should sign now, payments first, then orders, at most
// `limit` together.
export const findDueSignatures = async ({ now = new Date(), limit = 50, maxRetries = MAX_AUTO_RETRIES } = {}) => {
  const payments = await findDuePayments({ now, limit, maxRetries });
  const orders =
    payments.length < limit ? await findDueOrders({ now, limit: limit - payments.length, maxRetries }) : [];
  return [
    ...payments.map(({ _id }) => ({ kind: SIGN_KINDS.PAYMENT, id: _id })),
    ...orders.map(({ _id }) => ({ kind: SIGN_KINDS.ORDER, id: _id })),
  ];
};
