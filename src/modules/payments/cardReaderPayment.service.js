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
  retrieveCardReaderPaymentIntent,
  TEST_CARD_NUMBERS,
} from "../payouts/stripe.js";
import { applicationFeeCents } from "./onlinePayment.service.js";
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

const retrySchema = startSchema.pick({ expectedTotalCents: true });

const testCardSchema = z.object({
  card: z.enum(Object.keys(TEST_CARD_NUMBERS), { error: `card must be one of ${Object.keys(TEST_CARD_NUMBERS).join(", ")}` }),
});

const NAME_ORDER = { name: 1, createdAt: 1, _id: 1 };
const NAME_COLLATION = { locale: "de", strength: 2 };

const isCardReaderAttempt = (session) =>
  session?.status === "paying" && session.paymentInProgress?.kind === "card_reader";

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
// reader, or finds the attempt already running on it. With `retry`, it is
// the failed attempt's reader, and the attempt keeps its id; its earlier
// PaymentIntent may be used again while the total is the same. Returns
// { attempt, froze, previous }, `previous` being the failed attempt this
// one replaced.
const freeze = async (ctx, sessionId, expectedTotalCents, { reader, retry = false }) => {
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
        .select("status paymentInProgress failedCardReaderPayment")
        .session(mongoSession)
        .lean();
      if (session.status === "closed") throw new AppError("SESSION_CLOSED", "Session is closed");
      if (session.status === "paying") {
        const running = session.paymentInProgress;
        // The same start, or a retry another request made just now.
        const same = retry ? running?.retry : String(running?.readerId) === String(reader._id);
        if (isCardReaderAttempt(session) && same) {
          return { attempt: running, froze: false };
        }
        const freezeNow = billFreezeOf(session);
        throw new AppError("PAYMENT_IN_PROGRESS", "A payment is already in progress for this bill.", undefined, {
          kind: freezeNow?.kind ?? "ONLINE",
          readerName: freezeNow?.readerName ?? null,
        });
      }
      const previous = session.failedCardReaderPayment;
      if (retry && !previous) throw new AppError("NOT_FOUND", "No failed card reader payment to retry");
      if (bill.totalCents === 0) throw new AppError("BILL_EMPTY", "The bill is empty; close the table instead");
      if (bill.totalCents !== expectedTotalCents) {
        throw new AppError("BILL_CHANGED", "The bill changed; check the new total", undefined, {
          totalCents: bill.totalCents,
        });
      }
      if (retry) {
        reader = await CardReader.findOne({ _id: previous.readerId, restaurantId: ctx.restaurantId })
          .session(mongoSession)
          .lean();
        if (!reader) throw new AppError("NOT_FOUND", "Card reader not found");
      }
      const busyWith = (await busyReaders(ctx.restaurantId, mongoSession)).get(String(reader._id));
      if (busyWith) throw busy(busyWith.tableNumber);
      if (reader.status !== "online") throw offline();
      const attempt = {
        kind: "card_reader",
        attemptId: randomUUID(),
        cardReaderPaymentId: retry ? previous.cardReaderPaymentId : new mongoose.Types.ObjectId(),
        ...(retry ? { retry: true } : {}),
        ...(retry && previous.paymentIntentId && previous.amountCents === bill.totalCents
          ? { reusablePaymentIntentId: previous.paymentIntentId }
          : {}),
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
        { $set: { status: "paying", paymentInProgress: attempt }, $unset: { failedCardReaderPayment: 1 } }
      ).session(mongoSession);
      if (result.matchedCount === 0) throw new AppError("BILL_FROZEN", "The bill is frozen");
      return { attempt, froze: true, previous };
    });
  } finally {
    await mongoSession.endSession();
  }
};

// Puts the bill back to open, with the failed attempt it showed before,
// unless something else has moved it on since.
const unfreeze = (ctx, sessionId, attemptId, previous) =>
  TableSession.updateOne(
    { _id: sessionId, restaurantId: ctx.restaurantId, status: "paying", "paymentInProgress.attemptId": attemptId },
    {
      $set: { status: "open", ...(previous ? { failedCardReaderPayment: previous } : {}) },
      $unset: { paymentInProgress: 1 },
    }
  );

const stripeAccountOf = async (restaurantId) => {
  const restaurant = await Restaurant.findById(restaurantId).select("payoutAccount.stripeAccountId").lean();
  return restaurant?.payoutAccount?.stripeAccountId;
};

// Makes the PaymentIntent and tells the reader to collect it. Every Stripe
// call is keyed by the attempt, so a request that repeats the start, or
// finishes one that stopped halfway, gets Stripe's one PaymentIntent and
// one reader request.
// A retry's earlier PaymentIntent serves again while Stripe still waits for
// a card on it, for the same amount.
const stillUsable = async (stripeAccountId, attempt) => {
  const intent = await retrieveCardReaderPaymentIntent({
    stripeAccountId,
    paymentIntentId: attempt.reusablePaymentIntentId,
  });
  return intent.status === "requires_payment_method" && intent.amountCents === attempt.amountCents;
};

const sendToReader = async (ctx, sessionId, attempt) => {
  const stripeAccountId = await stripeAccountOf(ctx.restaurantId);
  let paymentIntentId = attempt.paymentIntentId;
  if (!paymentIntentId && attempt.reusablePaymentIntentId && (await stillUsable(stripeAccountId, attempt))) {
    paymentIntentId = attempt.reusablePaymentIntentId;
  }
  if (!paymentIntentId) {
    ({ paymentIntentId } = await createCardReaderPaymentIntent({
      stripeAccountId,
      attemptId: attempt.attemptId,
      amountCents: attempt.amountCents,
      applicationFeeCents: applicationFeeCents(attempt.amountCents),
      metadata: {
        restaurantId: String(ctx.restaurantId),
        sessionId: String(sessionId),
        attemptId: attempt.attemptId,
      },
    }));
  }
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
  return takeOnReader(ctx, sessionId, await freeze(ctx, sessionId, expectedTotalCents, { reader: fresh }));
};

// Staff retry the bill's failed card reader attempt (contract: Retry): the
// bill freezes again at its current total and goes to the same reader, as
// the same CardReaderPayment. The earlier PaymentIntent is used again when
// the total is unchanged and Stripe can still take a card on it; otherwise
// a new one is made. Retries racing each other give one reader request.
export const retryCardReaderPayment = async (ctx, sessionId, input) => {
  await findSession(ctx.restaurantId, sessionId);
  assertTerminalConfigured();
  const { expectedTotalCents } = parseOrThrow(retrySchema, input || {});
  await refreshFailedAttemptReader(ctx, sessionId);
  return takeOnReader(ctx, sessionId, await freeze(ctx, sessionId, expectedTotalCents, { retry: true }));
};

// Stores the status Stripe reports now for the failed attempt's reader, so
// the retry's freeze (which reads the reader in its transaction) refuses an
// offline reader just as a start does.
const refreshFailedAttemptReader = async (ctx, sessionId) => {
  const session = await TableSession.findOne({ _id: sessionId, restaurantId: ctx.restaurantId })
    .select("failedCardReaderPayment.readerId")
    .lean();
  const readerId = session?.failedCardReaderPayment?.readerId;
  if (!readerId) return;
  const reader = await CardReader.findOne({ _id: readerId, restaurantId: ctx.restaurantId }).lean();
  if (!reader) return;
  const restaurant = await Restaurant.findById(ctx.restaurantId).select("payoutAccount").lean();
  await withStripeStatus(ctx.restaurantId, restaurant?.payoutAccount, [reader]);
};

const takeOnReader = async (ctx, sessionId, { attempt, froze, previous }) => {
  if (!attempt.collecting) {
    try {
      await sendToReader(ctx, sessionId, attempt);
    } catch (error) {
      // Only the request that froze the bill unfreezes it: the other one's
      // request to Stripe may still succeed.
      if (froze) await unfreeze(ctx, sessionId, attempt.attemptId, previous);
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
    .select("status paymentInProgress failedCardReaderPayment")
    .lean();
  const extra = { freeze: billFreezeOf(session) };
  if (!staff) return extra;
  extra.cardReader = await cardReaderAvailability(restaurantId, bill, session);
  extra.cardReaderPayment = null;
  if (isCardReaderAttempt(session)) {
    extra.cardReaderPayment = serializeCardReaderPayment(sessionId, session.paymentInProgress);
  } else if (session?.status === "open" && !bill.payment && session.failedCardReaderPayment) {
    // A failed attempt is shown until something else pays or closes the bill.
    extra.cardReaderPayment = serializeCardReaderPayment(sessionId, session.failedCardReaderPayment);
  }
  return extra;
};
