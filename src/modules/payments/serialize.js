import { toIso as iso } from "../../shared/iso.js";

// How the guest paid by card, as kept on the Payment (`card`): the contract's
// paymentDetails, with only the fields Stripe gave. null when none was kept.
export const serializePaymentDetails = (card) => {
  if (!card?.type) return null;
  const fields = {
    type: card.type,
    brand: card.brand,
    last4: card.last4,
    funding: card.funding,
    wallet: card.wallet,
    authorizationCode: card.authorizationCode,
    aid: card.aid,
    applicationLabel: card.applicationLabel,
    readMethod: card.readMethod,
    transactionId: card.paymentIntentId,
    authorizedAt: iso(card.authorizedAt),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
};

export const serializePayment = (payment) => {
  if (!payment) return null;
  const source = payment.toObject ? payment.toObject() : payment;
  return {
    id: String(source._id),
    sessionId: String(source.sessionId),
    method: source.method,
    amountCents: source.amountCents,
    paidAt: iso(source.paidAt),
    receiptToken: source.receiptToken,
    signature: { status: source.tse?.status || "PENDING" },
    // Card reader payments only (the contract); online details are on the receipt.
    paymentDetails: source.method === "CARD_READER" ? serializePaymentDetails(source.card) : null,
  };
};
