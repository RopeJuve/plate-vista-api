import { logger } from "../../shared/logger.js";
import { signPaymentLater } from "../tse/signing.service.js";

const RENDER_TIMEOUT_MS = 1500;

// Vercel cannot keep working after it replied, so it hands the payment to the
// Render server over the internal channel (ADR-0005). Fire-and-forget: if
// the ping is lost, the sweep signs the payment.
const askRender = (paymentId) => {
  const base = process.env.RENDER_INTERNAL_URL;
  const secret = process.env.INTERNAL_SECRET;
  if (!base || !secret) {
    logger.warn({ paymentId: String(paymentId) }, "signing ping skipped: Render is not configured");
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  Promise.resolve()
    .then(() =>
      fetch(new URL("/internal/sign", base), {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": secret },
        body: JSON.stringify({ kind: "PAYMENT", id: String(paymentId) }),
        signal: controller.signal,
      })
    )
    .then((response) => {
      if (!response.ok) {
        logger.warn({ paymentId: String(paymentId), status: response.status }, "signing ping rejected");
      }
    })
    .catch((error) => {
      logger.warn({ paymentId: String(paymentId), err: error?.message }, "signing ping failed");
    })
    .finally(() => clearTimeout(timer));
};

// Called after a payment commits so the TSE signs it (ADR-0005). Tests swap
// `signing.requestSigning` to see the call.
export const signing = {
  requestSigning: async (paymentId) => {
    if ((process.env.DEPLOY_TARGET || "local") === "vercel") {
      askRender(paymentId);
      return;
    }
    signPaymentLater(paymentId);
  },
};

export const requestSigning = (paymentId) => signing.requestSigning(paymentId);
