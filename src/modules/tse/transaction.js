import { randomUUID } from "node:crypto";
import Restaurant from "../restaurants/restaurant.model.js";
import { FiskalyError } from "./fiskaly.client.js";
import { fiskaly, isTseActive } from "./tse.service.js";

// What every signer shares (ADR-0003, ADR-0005): one fiskaly transaction
// started and finished per signature, the retry rules, and the error text.

export const LOCK_MS = 60_000;
// After this many failures only a person retries (#29).
export const MAX_AUTO_RETRIES = 20;
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

// 30 s, 1 m, 2 m … capped at 30 m, for the n-th failure in a row.
export const backoffMs = (failures) =>
  Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);

// A signing problem on our side. A permanent one cannot be fixed by trying
// again, so automatic retries stop at once and a person has to look (#29).
export class SigningError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = "SigningError";
    this.permanent = permanent;
  }
}

export const isPermanent = (error) => error instanceof SigningError && error.permanent;

// fiskaly saying no or being down, and our own signing problems, are expected;
// anything else is a bug worth reporting.
export const isExpected = (error) => error instanceof FiskalyError || error instanceof SigningError;

export const fromUnix = (seconds) => (seconds == null ? undefined : new Date(Number(seconds) * 1000));

// The text kept in `lastError`: short, and never a PIN, PUK or secret
// (fiskaly's messages carry none).
export const lastErrorText = (error) => {
  const text =
    error instanceof FiskalyError
      ? `fiskaly ${error.status}${error.code ? ` ${error.code}` : ""}: ${error.message}`
      : error?.message || String(error);
  return text.slice(0, 500);
};

// The restaurant's TSS and client, or a SigningError when its TSE can't sign.
export const signingDevice = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("tse").lean();
  const { tssId, clientId } = restaurant?.tse || {};
  if (!isTseActive(restaurant) || !tssId || !clientId) {
    throw new SigningError("the restaurant's TSE is not active");
  }
  return { tssId, clientId };
};

// Runs one fiskaly transaction to FINISHED and returns it. A new transaction
// id is handed to `saveTxId` before fiskaly hears it, and an existing one is
// first asked about, so a run that stopped half way is picked up. A
// transaction that ended CANCELLED can't be finished: a new one is started.
// `schema` is called only when the transaction still has to be finished.
export const finishTransaction = async ({ tssId, clientId, txId, saveTxId, schema }) => {
  const client = fiskaly();
  let id = txId;
  let tx = id ? await client.getTx(tssId, id) : null;
  if (!id || tx?.state === "CANCELLED") {
    id = randomUUID();
    tx = null;
    await saveTxId(id);
  }
  if (!tx) tx = await client.startTx(tssId, id, { clientId });
  if (tx.state === "ACTIVE") {
    tx = await client.finishTx(tssId, id, {
      clientId,
      schema: await schema(),
      revision: Number(tx.revision || 1) + 1,
    });
  }
  if (tx.state !== "FINISHED") throw new SigningError(`the fiskaly transaction is ${tx.state}`);
  return { txId: id, tx };
};

// What a failed attempt stores: the error, one more retry (or the limit at
// once when it is permanent), and when to try again.
export const failureFields = (error, previousRetries) => {
  const retryCount = isPermanent(error) ? MAX_AUTO_RETRIES : (previousRetries || 0) + 1;
  return {
    status: "FAILED",
    lastError: lastErrorText(error),
    retryCount,
    nextAttemptAt: new Date(Date.now() + backoffMs(retryCount)),
  };
};
