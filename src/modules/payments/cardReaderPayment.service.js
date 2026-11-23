import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { z } from "zod";
import Restaurant from "../restaurants/restaurant.model.js";
import TableSession from "../ordering/session.model.js";
import CardReader from "../cardReaders/cardReader.model.js";
import { busyReaders, serializeCardReader, withStripeStatus } from "../cardReaders/cardReader.service.js";
import { getSessionBill } from "../ordering/order.service.js";
import { findSession } from "../ordering/session.service.js";
import { isTseActive } from "../tse/tse.service.js";
import {
  assertTerminalConfigured,
  collectOnCardReader,
  createCardReaderPaymentIntent,
  isStripeTestMode,
  presentTestCard as presentStripeTestCard,
  retrieveCardReaderPaymentDetails,
  TEST_CARD_NUMBERS,
} from "../payouts/stripe.js";
import Payment from "./payment.model.js";
import { applicationFeeCents } from "./onlinePayment.service.js";
import { recordCardReaderPayment } from "./payment.service.js";
import { publishBillFrozen } from "./events.js";
import { AppError } from "../../shared/errors.js";
import { parseOrThrow } from "../../shared/validate.js";
import { captureException, logger } from "../../shared/logger.js";

// How long the reader waits for a card before the attempt ends (#93 sweeps it).
const EXPIRES_IN_MS = 3 * 60 * 1000;

const startSchema = z.object({
  readerId: z
    .string({ error: "readerId must be a card reader id" })
    .refine((id) => mongoose.isValidObjectId(id), "readerId must be a card reader id"),
  expectedTotalCents: z
    .number({ error: "expectedTotalCents must be a whole number of cents" })
    .int("expectedTotalCents must be a whole number of cents")
    .min(0, "expectedTotalCents must be >= 0"),
});

const testCardSchema = z.object({
  card: z.enum(Object.keys(TEST_CARD_NUMBERS), { error: `card must be one of ${Object.keys(TEST_CARD_NUMBERS).join(", ")}` }),
});

const NAME_ORDER = { name: 1, createdAt: 1, _id: 1 };
const NAME_COLLATION = { locale: "de", strength: 2 };

const isCardReaderAttempt = (session) =>
  session?.status === "paying" && session.paymentInProgress?.kind === "card_reader";

// The contract's CardReaderPayment for the attempt a bill is frozen for.
export const serializeCardReaderPayment = (sessionId, attempt) => ({
  id: String(attempt.cardReaderPaymentId),
  sessionId: String(sessionId),
  reader: { id: String(attempt.readerId), name: attempt.readerName, simulated: Boolean(attempt.readerSimulated) },
  amountCents: attempt.amountCents,
  status: "IN_PROGRESS",
  failure: null,
  startedAt: attempt.startedAt.toISOString(),
  expiresAt: attempt.expiresAt.toISOString(),
});

// The contract's BillFreeze: why the bill is frozen; null unless it is.
export const billFreezeOf = (session) => {
  const attempt = session?.paymentInProgress;
  if (session?.status !== "paying" || !attempt) return null;
  const cardReader = attempt.kind === "card_reader";
  return {
    kind: cardReader ? "CARD_READER" : "ONLINE",
    readerName: cardReader ? attempt.readerName : null,
    totalCents: attempt.amountCents,
    expiresAt: attempt.expiresAt.toISOString(),
  };
};

const unavailable = (reason) =>
  new AppError("CARD_READER_PAYMENT_UNAVAILABLE", "Card reader payments are not available.", undefined, { reason });

// The restaurant's reader staff chose.
const findReader = async (restaurantId, readerId) => {
  const reader = await CardReader.findOne({ _id: readerId, restaurantId }).lean();
  if (!reader) throw new AppError("NOT_FOUND", "Card reader not found");
  return reader;
};

const offline = () => new AppError("CARD_READER_OFFLINE", "The card reader is offline.");

const busy = (tableNumber) =>
  new AppError("CARD_READER_BUSY", "The card reader is taking another table's payment.", undefined, { tableNumber });

// Freezes the open bill at its total for a card reader payment on this
// reader, or finds the attempt already running on it. Returns
// { attempt, froze }.
const freeze = async (ctx, sessionId, reader, expectedTotalCents) => {
  const mongoSession = await mongoose.startSession();
  try {
    return await mongoSession.withTransaction(async () => {
      const now = Date.now();
      const restaurant = await Restaurant.findById(ctx.restaurantId)
        .select("payoutAccount tse.setupStep")
        .session(mongoSession)
        .lean();
      if (!restaurant?.payoutAccount?.stripeAccountId || !restaurant.payoutAccount.chargesEnabled) {
        throw unavailable("PAYOUT_ACCOUNT_NOT_READY");
      }
      if (!isTseActive(restaurant)) throw unavailable("TSE_NOT_ACTIVE");
      const bill = await getSessionBill(ctx, sessionId, mongoSession);
      if (bill.payment) throw new AppError("BILL_PAID", "This bill is paid");
      const session = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId })
        .select("status paymentInProgress")
        .session(mongoSession)
        .lean();
      if (session.status === "closed") throw new AppError("SESSION_CLOSED", "Session is closed");
      if (session.status === "paying") {
        const running = session.paymentInProgress;
        if (isCardReaderAttempt(session) && String(running.readerId) === String(reader._id)) {
          return { attempt: running, froze: false };
        }
        const freezeNow = billFreezeOf(session);
        throw new AppError("PAYMENT_IN_PROGRESS", "A payment is already in progress for this bill.", undefined, {
          kind: freezeNow?.kind ?? "ONLINE",
          readerName: freezeNow?.readerName ?? null,
        });
      }
      if (bill.totalCents === 0) throw new AppError("BILL_EMPTY", "The bill is empty; close the table instead");
      if (bill.totalCents !== expectedTotalCents) {
        throw new AppError("BILL_CHANGED", "The bill changed; check the new total", undefined, {
          totalCents: bill.totalCents,
        });
      }
      const busyWith = (await busyReaders(ctx.restaurantId, mongoSession)).get(String(reader._id));
      if (busyWith) throw busy(busyWith.tableNumber);
      if (reader.status !== "online") throw offline();
      const attempt = {
        kind: "card_reader",
        attemptId: randomUUID(),
        cardReaderPaymentId: new mongoose.Types.ObjectId(),
        readerId: reader._id,
        readerName: reader.name,
        readerSimulated: Boolean(reader.simulated),
        stripeReaderId: reader.stripeReaderId,
        amountCents: bill.totalCents,
        startedAt: new Date(now),
        expiresAt: new Date(now + EXPIRES_IN_MS),
      };
      // Writing the session makes an order or cancel racing this freeze
      // conflict, so one of them retries and sees the other.
      const result = await TableSession.updateOne(
        { _id: sessionId, restaurantId: ctx.restaurantId, status: "open" },
        { $set: { status: "paying", paymentInProgress: attempt } }
      ).session(mongoSession);
      if (result.matchedCount === 0) throw new AppError("BILL_FROZEN", "The bill is frozen");
      return { attempt, froze: true, stripeAccountId: restaurant.payoutAccount.stripeAccountId };
    });
  } finally {
    await mongoSession.endSession();
  }
};

// Puts the bill back to open, unless something else has moved it on since.
const unfreeze = (ctx, sessionId, attemptId) =>
  TableSession.updateOne(
    { _id: sessionId, restaurantId: ctx.restaurantId, status: "paying", "paymentInProgress.attemptId": attemptId },
    { $set: { status: "open" }, $unset: { paymentInProgress: 1 } }
  );

const stripeAccountOf = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("payoutAccount.stripeAccountId").lean();
  return restaurant?.payoutAccount?.stripeAccountId;
};

// Makes the PaymentIntent and tells the reader to collect it. Every Stripe
// call is keyed by the attempt, so a request that repeats the start, or
// finishes one that stopped halfway, gets Stripe's one PaymentIntent and
// one reader request.
const sendToReader = async (ctx, sessionId, attempt) => {
  const stripeAccountId = await stripeAccountOf(ctx.restaurantId);
  const { paymentIntentId } = await createCardReaderPaymentIntent({
    stripeAccountId,
    attemptId: attempt.attemptId,
    amountCents: attempt.amountCents,
    applicationFeeCents: applicationFeeCents(attempt.amountCents),
    metadata: {
      restaurantId: String(ctx.restaurantId),
      sessionId: String(sessionId),
      attemptId: attempt.attemptId,
    },
  });
  await TableSession.updateOne(
    { _id: sessionId, restaurantId: ctx.restaurantId, "paymentInProgress.attemptId": attempt.attemptId },
    { $set: { "paymentInProgress.paymentIntentId": paymentIntentId } }
  );
  await collectOnCardReader({
    stripeAccountId,
    stripeReaderId: attempt.stripeReaderId,
    paymentIntentId,
    attemptId: attempt.attemptId,
  });
  await TableSession.updateOne(
    { _id: sessionId, restaurantId: ctx.restaurantId, "paymentInProgress.attemptId": attempt.attemptId },
    { $set: { "paymentInProgress.collecting": true } }
  );
};

// Staff send the bill's whole total to a card reader (ADR-0008). The bill
// freezes first, then Stripe gets the PaymentIntent and the reader asks for
// the card. Starting again on the same reader while it runs gives the same
// attempt, with no new PaymentIntent, reader request or event.
export const startCardReaderPayment = async (ctx, sessionId, input) => {
  await findSession(ctx.restaurantId, sessionId);
  assertTerminalConfigured();
  const { readerId, expectedTotalCents } = parseOrThrow(startSchema, input || {});
  const reader = await findReader(ctx.restaurantId, readerId);
  const restaurant = await Restaurant.findById(ctx.restaurantId).select("payoutAccount").lean();
  const [fresh] = await withStripeStatus(ctx.restaurantId, restaurant?.payoutAccount, [reader]);
  const { attempt, froze } = await freeze(ctx, sessionId, fresh, expectedTotalCents);

  if (!attempt.collecting) {
    try {
      await sendToReader(ctx, sessionId, attempt);
    } catch (error) {
      // Only the request that froze the bill unfreezes it: the other one's
      // request to Stripe may still succeed.
      if (froze) await unfreeze(ctx, sessionId, attempt.attemptId);
      // Stripe refuses a reader that is offline, or busy with something we
      // did not start; whatever it is doing is left alone.
      if (error?.code === "terminal_reader_offline") throw offline();
      if (error?.code === "terminal_reader_busy") throw busy(null);
      logger.error(
        { restaurantId: String(ctx.restaurantId), sessionId: String(sessionId), requestId: ctx.requestId, err: error },
        "starting the card reader payment failed"
      );
      captureException(error);
      throw new AppError("PAYMENT_PROVIDER_ERROR", "The payment provider could not start the card reader payment");
    }
  }

  if (froze) {
    publishBillFrozen({
      restaurantId: ctx.restaurantId,
      sessionId,
      expiresAt: attempt.expiresAt,
      kind: "CARD_READER",
      readerName: attempt.readerName,
      totalCents: attempt.amountCents,
    });
  }
  return serializeCardReaderPayment(sessionId, attempt);
};

// Test mode only: taps one of Stripe's test cards on the Simulated Reader the
// bill's card reader payment runs on. What happens then arrives as webhooks.
export const presentTestCard = async (ctx, sessionId, input) => {
  await findSession(ctx.restaurantId, sessionId);
  assertTerminalConfigured();
  const { card } = parseOrThrow(testCardSchema, input || {});
  if (!isStripeTestMode()) {
    throw new AppError("SIMULATED_READER_LIVE_MODE", "Simulated readers exist only in test mode.");
  }
  const session = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId })
    .select("status paymentInProgress")
    .lean();
  if (!isCardReaderAttempt(session) || !session.paymentInProgress.collecting) {
    throw new AppError("NOT_FOUND", "No card reader payment is in progress for this bill");
  }
  const attempt = session.paymentInProgress;
  if (!attempt.readerSimulated) {
    throw new AppError("CARD_READER_NOT_SIMULATED", "Test cards work only on a simulated reader.");
  }
  try {
    await presentStripeTestCard({
      stripeAccountId: await stripeAccountOf(ctx.restaurantId),
      stripeReaderId: attempt.stripeReaderId,
      card,
    });
  } catch (error) {
    logger.error(
      { restaurantId: String(ctx.restaurantId), sessionId: String(sessionId), requestId: ctx.requestId, err: error },
      "presenting a test card failed"
    );
    captureException(error);
    throw new AppError("PAYMENT_PROVIDER_ERROR", "The payment provider could not present the test card");
  }
  return serializeCardReaderPayment(sessionId, attempt);
};

// The pay panel's card reader button (staff only): HIDDEN without Stripe,
// readers or an open bill; DISABLED with the first reason that applies;
// otherwise OFFERED. The readers come with the status Stripe reports now and
// the bill each one is taking a payment for.
export const cardReaderAvailability = async (restaurantId, bill, session) => {
  const hidden = { state: "HIDDEN", reason: null, readers: [] };
  if (!process.env.STRIPE_SECRET_KEY || session?.status === "closed") return hidden;
  const stored = await CardReader.find({ restaurantId }).sort(NAME_ORDER).collation(NAME_COLLATION).lean();
  if (stored.length === 0) return hidden;
  const restaurant = await Restaurant.findById(restaurantId).select("payoutAccount tse.setupStep").lean();
  const readers = await withStripeStatus(restaurantId, restaurant?.payoutAccount, stored);
  const busy = await busyReaders(restaurantId);
  const takingAnotherBill = (reader) => {
    const busyWith = busy.get(String(reader._id));
    return Boolean(busyWith) && busyWith.sessionId !== String(session?._id);
  };
  const canTake = (reader) => reader.status === "online" && !takingAnotherBill(reader);
  let reason = null;
  if (!restaurant?.payoutAccount?.chargesEnabled) reason = "PAYOUT_ACCOUNT_NOT_READY";
  else if (!isTseActive(restaurant)) reason = "TSE_NOT_ACTIVE";
  else if (bill.payment) reason = "BILL_PAID";
  else if (!(bill.totalCents > 0)) reason = "BILL_EMPTY";
  else if (session?.status === "paying") reason = "PAYMENT_IN_PROGRESS";
  else if (!readers.some(canTake)) reason = "NO_READER_AVAILABLE";
  return {
    state: reason ? "DISABLED" : "OFFERED",
    reason,
    readers: readers.map((reader) => serializeCardReader(reader, busy.get(String(reader._id)))),
  };
};

// What GET /sessions/:id/bill adds for the pay panel: `freeze` for everyone;
// `cardReader` and `cardReaderPayment` for staff only.
export const payPanelOf = async (restaurantId, sessionId, bill, { staff }) => {
  const session = await TableSession.findOne({ _id: sessionId, restaurantId })
    .select("status paymentInProgress")
    .lean();
  const extra = { freeze: billFreezeOf(session) };
  if (!staff) return extra;
  extra.cardReader = await cardReaderAvailability(restaurantId, bill, session);
  extra.cardReaderPayment = isCardReaderAttempt(session)
    ? serializeCardReaderPayment(sessionId, session.paymentInProgress)
    : null;
  return extra;
};

// The bill a card reader PaymentIntent was made for, from the metadata
// startCardReaderPayment gave it; null when it names none.
const billOf = (intent) => {
  const { restaurantId, sessionId } = intent?.metadata || {};
  if (!mongoose.isValidObjectId(restaurantId) || !mongoose.isValidObjectId(sessionId)) return null;
  return { restaurantId, sessionId };
};

const STRIPE_ACTOR = { type: "system", id: "stripe" };

// Stripe's `payment_intent.amount_capturable_updated`: the card was
// authorized on the reader. While the bill is still frozen for this
// PaymentIntent, it is captured and recorded as the bill's CARD_READER
// Payment, through the same path as every Payment. A repeated or late event
// replays (the PaymentIntent id is the clientPaymentId). An authorization
// the bill is no longer frozen for is left alone here; #93 releases it.
export const captureCardReaderAuthorization = async (event) => {
  const intent = event.data?.object;
  if (!intent?.id || !(intent.payment_method_types || []).includes("card_present")) return;
  const bill = billOf(intent);
  const log = { eventId: event.id, paymentIntentId: intent.id, ...bill };
  if (!bill) {
    logger.warn(log, "authorized card reader PaymentIntent names no bill; ignored");
    return;
  }
  const ctx = { restaurantId: bill.restaurantId, requestId: event.id, actor: STRIPE_ACTOR };
  let recorded;
  try {
    recorded = await recordCardReaderPayment(ctx, bill.sessionId, { paymentIntentId: intent.id, stripeAccountId: event.account });
  } catch (error) {
    if (["NOT_FROZEN_FOR_IT", "BILL_PAID", "NOT_FOUND", "VALIDATION"].includes(error?.code)) {
      logger.warn({ ...log, err: error }, "card reader authorization for a bill not frozen for it; not captured");
      return;
    }
    throw error;
  }
  await keepCardPresentDetails(recorded?.payment, event.account, log);
};

// Keeps what the card receipt needs (brand, last 4, authorization code, AID,
// application label, read method) on the Payment. Best effort: the payment
// stands without it, and a redelivered event (which replays the Payment)
// tries again.
const keepCardPresentDetails = async (payment, stripeAccountId, log) => {
  if (!payment || payment.card) return;
  try {
    const card = await retrieveCardReaderPaymentDetails({ stripeAccountId, paymentIntentId: payment.clientPaymentId });
    if (!card) return;
    await Payment.updateOne({ _id: payment._id, restaurantId: payment.restaurantId }, { $set: { card } });
  } catch (error) {
    logger.error({ ...log, err: error }, "reading the card reader payment's card details from Stripe failed");
    captureException(error);
  }
};
