import TableSession, { PAYMENT_IN_PROGRESS_KIND } from "../ordering/session.model.js";

// What a frozen bill waits for (GLOSSARY.md, Bill): the session is `paying`
// and `paymentInProgress` is the attempt, an online payment or a card reader
// payment.

// bill.unfrozen's reason: why a frozen bill opened again without being paid.
// FAILED is for card readers only.
export const UNFREEZE_REASON = Object.freeze({
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
  STAFF_PAYMENT: "STAFF_PAYMENT",
  FAILED: "FAILED",
});

// The contract's BillFreeze.kind (and bill.frozen's) for each attempt kind.
export const BILL_FREEZE_KIND = Object.freeze({
  [PAYMENT_IN_PROGRESS_KIND.ONLINE]: "ONLINE",
  [PAYMENT_IN_PROGRESS_KIND.CARD_READER]: "CARD_READER",
});

// The bill is frozen for a card reader payment; CARD_READER_ATTEMPT is the
// same as a query filter.
export const isCardReaderAttempt = (session) =>
  session?.status === "paying" && session.paymentInProgress?.kind === PAYMENT_IN_PROGRESS_KIND.CARD_READER;
export const CARD_READER_ATTEMPT = Object.freeze({
  status: "paying",
  "paymentInProgress.kind": PAYMENT_IN_PROGRESS_KIND.CARD_READER,
});

// Opens the bill again while it is still frozen for the attempt `attemptId`
// (and matches `match`), setting `set` too. Returns whether it did: false
// when something else moved the bill on first.
export const reopenFrozenBill = async ({ restaurantId, sessionId, attemptId, match = {}, set = {}, mongoSession = null }) => {
  const result = await TableSession.updateOne(
    { _id: sessionId, restaurantId, status: "paying", "paymentInProgress.attemptId": attemptId, ...match },
    { $set: { status: "open", ...set }, $unset: { paymentInProgress: 1 } }
  ).session(mongoSession);
  return result.modifiedCount > 0;
};

// The session's status now.
export const sessionStatusOf = async (restaurantId, sessionId) =>
  (await TableSession.findOne({ _id: sessionId, restaurantId }).select("status").lean())?.status;

// The contract's BillFreeze: why the bill is frozen; null unless it is.
export const billFreezeOf = (session) => {
  const attempt = session?.paymentInProgress;
  if (session?.status !== "paying" || !attempt) return null;
  const cardReader = attempt.kind === PAYMENT_IN_PROGRESS_KIND.CARD_READER;
  return {
    kind: BILL_FREEZE_KIND[attempt.kind],
    readerName: cardReader ? attempt.readerName : null,
    totalCents: attempt.amountCents,
    expiresAt: attempt.expiresAt.toISOString(),
  };
};

// The contract's CardReaderPayment for the attempt a bill is frozen for, or
// for the last one that failed.
export const serializeCardReaderPayment = (sessionId, attempt) => ({
  id: String(attempt.cardReaderPaymentId),
  sessionId: String(sessionId),
  reader: { id: String(attempt.readerId), name: attempt.readerName, simulated: Boolean(attempt.readerSimulated) },
  amountCents: attempt.amountCents,
  status: attempt.failure ? "FAILED" : "IN_PROGRESS",
  failure: attempt.failure ? { reason: attempt.failure.reason, message: attempt.failure.message } : null,
  startedAt: attempt.startedAt.toISOString(),
  expiresAt: attempt.expiresAt.toISOString(),
});
