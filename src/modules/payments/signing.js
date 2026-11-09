import { logger } from "../../shared/logger.js";
import { postToRender, runsOnVercel } from "../../shared/renderChannel.js";
import { signLater } from "../tse/signing.service.js";

// Vercel hands the signing to Render (ADR-0005). Fire-and-forget: if the
// ping is lost, the sweep signs it.
const askRender = ({ kind, id }) => {
  const target = { kind, id: String(id) };
  const sent = postToRender("/internal/sign", target, target);
  if (!sent) logger.warn(target, "signing ping skipped: Render is not configured");
};

// Called after a payment or an order commits so the TSE signs it
// (ADR-0005), with `{ kind: "PAYMENT" | "ORDER", id }`. Tests swap
// `signing.requestSigning` to see the call.
export const signing = {
  requestSigning: async (target) => {
    if (runsOnVercel()) {
      askRender(target);
      return;
    }
    signLater(target);
  },
};

export const requestSigning = (target) => signing.requestSigning(target);
