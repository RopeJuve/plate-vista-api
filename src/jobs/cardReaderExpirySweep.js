import { captureException, logger } from "../shared/logger.js";
import { expireCardReaderPayments } from "../modules/payments/cardReaderPaymentEnd.js";

// Every 15 s, ends the card reader payments nobody presented a card for by
// their expiresAt (3 min after the start): the reader is cleared and the
// bill unfreezes with reason EXPIRED. Runs only where ENABLE_JOBS=true
// (src/server.js). A run never overlaps the one before it.
export const createCardReaderExpirySweep = ({
  intervalMs = 15_000,
  batchSize = 50,
  now = () => new Date(),
  expire = expireCardReaderPayments,
} = {}) => {
  let timer = null;
  let running = null;

  const runOnce = async () => {
    if (running) return { skipped: true };
    running = expire({ now: now(), limit: batchSize });
    try {
      return { skipped: false, ended: await running };
    } finally {
      running = null;
    }
  };

  const tick = () => {
    runOnce().catch((error) => {
      logger.error({ err: error }, "card reader expiry sweep failed");
      captureException(error);
    });
  };

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running.catch(() => {});
    },
  };
};
