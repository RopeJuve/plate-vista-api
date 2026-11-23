import Restaurant from "../restaurants/restaurant.model.js";
import TableSession from "../ordering/session.model.js";
import { readersWithStatus, serializeCardReader } from "../cardReaders/cardReader.service.js";
import { isTseActive } from "../tse/tse.service.js";
import { billFreezeOf, isCardReaderAttempt, serializeCardReaderPayment } from "./billFreeze.js";

// The pay panel's card reader button (staff only): HIDDEN without Stripe,
// readers or an open bill; DISABLED with the first reason that applies;
// otherwise OFFERED. The readers come with the status Stripe reported at
// most 30 s ago and the bill each one is taking a payment for.
export const cardReaderAvailability = async (restaurantId, bill, session) => {
  const hidden = { state: "HIDDEN", reason: null, readers: [] };
  if (!process.env.STRIPE_SECRET_KEY || session?.status === "closed") return hidden;
  const restaurant = await Restaurant.findById(restaurantId).select("payoutAccount tse.setupStep").lean();
  const { readers, busy } = await readersWithStatus(restaurantId, restaurant?.payoutAccount);
  if (readers.length === 0) return hidden;
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
  const panel = { freeze: billFreezeOf(session) };
  if (!staff) return panel;
  panel.cardReader = await cardReaderAvailability(restaurantId, bill, session);
  panel.cardReaderPayment = null;
  if (isCardReaderAttempt(session)) {
    panel.cardReaderPayment = serializeCardReaderPayment(sessionId, session.paymentInProgress);
  } else if (session?.status === "open" && !bill.payment && session.failedCardReaderPayment) {
    // A failed attempt is shown until something else pays or closes the bill.
    panel.cardReaderPayment = serializeCardReaderPayment(sessionId, session.failedCardReaderPayment);
  }
  return panel;
};
