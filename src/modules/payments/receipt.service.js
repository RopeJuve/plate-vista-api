import Payment from "./payment.model.js";
import Restaurant from "../restaurants/restaurant.model.js";
import TableSession from "../ordering/session.model.js";
import Table from "../tables/table.model.js";
import { serializeLegalDetails } from "../restaurants/legal.js";
import { getBillLines } from "../ordering/order.service.js";
import { mergeReceiptLines, totalsByVat } from "./money.js";
import { AppError } from "../../shared/errors.js";
import { toIso as iso } from "../../shared/iso.js";
import { captureException, logger } from "../../shared/logger.js";
import { reconcileOnlinePayment } from "./onlinePayment.service.js";

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

// How the guest paid by card, when it was kept (payments the provider
// records only, and not for payments recorded before it was).
const serializeCard = (card) => {
  if (!card?.type) return {};
  const fields = {
    type: card.type,
    brand: card.brand,
    last4: card.last4,
    funding: card.funding,
    wallet: card.wallet,
    authorizationCode: card.authorizationCode,
    transactionId: card.paymentIntentId,
    authorizedAt: iso(card.authorizedAt),
  };
  return { paymentDetails: Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null)) };
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
  const [restaurant, table, billLines] = await Promise.all([
    Restaurant.findById(payment.restaurantId).select("name legal").lean(),
    Table.findOne({ _id: payment.tableId, restaurantId: payment.restaurantId })
      .select("tableNumber")
      .lean(),
    getBillLines(payment.restaurantId, payment.sessionId),
  ]);
  if (!restaurant) throw notFound();
  const lines = mergeReceiptLines(billLines);
  // Bill lines come in the order they were ordered, so the first is the
  // Service Period's start; wholly cancelled orders have no lines.
  const servedFrom = billLines[0]?.orderedAt;
  const totals = totalsByVat(lines);
  warnIfTotalsDrift(payment, totals);
  return {
    restaurant: serializeRestaurant(restaurant),
    // The Receipt Number is the TSE's transaction number (ADR-0007).
    receiptNumber: payment.tse?.status === "SIGNED" && payment.tse.txNumber != null ? payment.tse.txNumber : null,
    ...(table ? { tableNumber: table.tableNumber } : {}),
    servicePeriod: { start: iso(servedFrom) ?? iso(payment.paidAt), end: iso(payment.paidAt) },
    lines,
    totalsByVat: totals,
    totalCents: payment.amountCents,
    method: payment.method,
    ...serializeCard(payment.card),
    paidAt: iso(payment.paidAt),
    signature: serializeSignature(payment.tse),
  };
};

// What the guest's app polls after paying: the receipt token once the bill
// has a payment, or PAYING while an online payment is still in progress.
// Works after the session is closed, so a guest can still find their receipt.
// While paying, Stripe is asked too, so a payment whose webhook never came
// is still recorded and the guest gets their receipt.
const findReceiptToken = (restaurantId, sessionId) =>
  Payment.findOne({ restaurantId, sessionId }).select("receiptToken").lean();

export const getReceiptTokenForSession = async (restaurantId, sessionId) => {
  const payment = await findReceiptToken(restaurantId, sessionId);
  if (payment) return { receiptToken: payment.receiptToken };
  const session = await TableSession.findOne({ _id: sessionId, restaurantId }).select("status").lean();
  if (session?.status !== "paying") throw notFound();
  try {
    if (await reconcileOnlinePayment(restaurantId, sessionId)) {
      const recorded = await findReceiptToken(restaurantId, sessionId);
      if (recorded) return { receiptToken: recorded.receiptToken };
    }
  } catch (error) {
    // Stripe unreachable or not set up: keep answering PAYING; the guest asks again.
    if (error?.code !== "STRIPE_NOT_CONFIGURED") {
      logger.error({ restaurantId: String(restaurantId), sessionId: String(sessionId), err: error }, "checking the online payment with Stripe failed");
      captureException(error);
    }
  }
  return { status: "PAYING" };
};
