import { logger } from "../../shared/logger.js";
import { postToRender, runsOnVercel } from "../../shared/renderChannel.js";
import { SIGN_KINDS, signPaymentLater } from "../tse/signing.service.js";

// Vercel hands the payment to Render (ADR-0005). Fire-and-forget: if the
// ping is lost, the sweep signs the payment.
const askRender = (paymentId) => {
  const id = String(paymentId);
  const sent = postToRender("/internal/sign", { kind: SIGN_KINDS.PAYMENT, id }, { paymentId: id });
  if (!sent) logger.warn({ paymentId: id }, "signing ping skipped: Render is not configured");
};

// Called after a payment commits so the TSE signs it (ADR-0005). Tests swap
// `signing.requestSigning` to see the call.
export const signing = {
  requestSigning: async (paymentId) => {
    if (runsOnVercel()) {
      askRender(paymentId);
      return;
    }
    signPaymentLater(paymentId);
  },
};

export const requestSigning = (paymentId) => signing.requestSigning(paymentId);
