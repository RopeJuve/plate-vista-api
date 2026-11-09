import { toIso as iso } from "../../shared/iso.js";

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
  };
};
