import Payment from "./payment.model.js";
import Restaurant from "../restaurants/restaurant.model.js";
import { serializeLegalDetails } from "../restaurants/legal.js";
import { getBillLines } from "../ordering/order.service.js";
import { mergeReceiptLines, totalsByVat } from "./money.js";
import { AppError } from "../../shared/errors.js";

const RECEIPT_TOKEN = /^[0-9a-f]{32}$/;

const iso = (value) => (value == null ? undefined : new Date(value).toISOString());

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

// The guest's Receipt, found by its token alone: the token is the only
// credential, so this reads across restaurants.
export const getReceipt = async (receiptToken) => {
  if (typeof receiptToken !== "string" || !RECEIPT_TOKEN.test(receiptToken)) throw notFound();
  const payment = await Payment.findOne({ receiptToken }).setOptions({ skipTenant: true }).lean();
  if (!payment) throw notFound();
  const restaurant = await Restaurant.findById(payment.restaurantId).select("name legal").lean();
  if (!restaurant) throw notFound();
  const lines = mergeReceiptLines(await getBillLines(payment.restaurantId, payment.sessionId));
  return {
    restaurant: serializeRestaurant(restaurant),
    lines,
    totalsByVat: totalsByVat(lines),
    totalCents: payment.amountCents,
    method: payment.method,
    paidAt: iso(payment.paidAt),
    signature: serializeSignature(payment.tse),
  };
};
