import Payment from "./payment.model.js";
import Restaurant from "../restaurants/restaurant.model.js";
import { serializeLegalDetails } from "../restaurants/legal.js";
import { getBillLines } from "../ordering/order.service.js";
import { mergeReceiptLines, totalsByVat } from "./money.js";
import { AppError } from "../../shared/errors.js";
import { toIso as iso } from "../../shared/iso.js";
import { logger } from "../../shared/logger.js";

const RECEIPT_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

const notFound = () => new AppError("NOT_FOUND", "Not found", 404);

const serializeRestaurant = (restaurant) => {
  const legal = serializeLegalDetails(restaurant);
  return {
    name: restaurant.name,
    legalName: legal.legalName,
    address: legal.address,
    ...(legal.taxNumber ? { taxNumber: legal.taxNumber } : {}),
    ...(legal.vatId ? { vatId: legal.vatId } : {}),
  };
};

// The TSE's signature goes on the receipt only once it is there (ADR-0005).
const serializeSignature = (tse = {}) => {
  const status = tse.status || "PENDING";
  if (status !== "SIGNED") return { status };
  const fields = {
    txNumber: tse.txNumber,
    timeStart: iso(tse.timeStart),
    timeEnd: iso(tse.timeEnd),
    value: tse.signatureValue,
    counter: tse.signatureCounter,
    tssSerial: tse.tssSerial,
    clientSerial: tse.clientSerial,
    qrCodeData: tse.qrCodeData,
  };
  return {
    status,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null)),
  };
};

// The lines are rebuilt from the orders on every read, while the total is the
// one stored on the payment. They agree by construction; if they ever don't,
// say so loudly rather than hand out a receipt that doesn't add up unnoticed.
const warnIfTotalsDrift = (payment, totals) => {
  const grossCents = totals.reduce((sum, rate) => sum + rate.grossCents, 0);
  if (grossCents === payment.amountCents) return;
  logger.error(
    {
      restaurantId: String(payment.restaurantId),
      paymentId: String(payment._id),
      grossCents,
      totalCents: payment.amountCents,
    },
    "receipt lines do not add up to the paid total"
  );
};

// The guest's Receipt, found by its token alone: the token is the only
// credential, so this reads across restaurants.
export const getReceipt = async (receiptToken) => {
  if (typeof receiptToken !== "string" || !RECEIPT_TOKEN_PATTERN.test(receiptToken)) {
    throw notFound();
  }
  const payment = await Payment.findOne({ receiptToken }).setOptions({ skipTenant: true }).lean();
  if (!payment) throw notFound();
  const restaurant = await Restaurant.findById(payment.restaurantId).select("name legal").lean();
  if (!restaurant) throw notFound();
  const lines = mergeReceiptLines(await getBillLines(payment.restaurantId, payment.sessionId));
  const totals = totalsByVat(lines);
  warnIfTotalsDrift(payment, totals);
  return {
    restaurant: serializeRestaurant(restaurant),
    lines,
    totalsByVat: totals,
    totalCents: payment.amountCents,
    method: payment.method,
    paidAt: iso(payment.paidAt),
    signature: serializeSignature(payment.tse),
  };
};
