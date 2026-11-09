import { captureException, logger } from "../shared/logger.js";
import {
  findDuePayments,
  MAX_AUTO_RETRIES,
  signPayment,
} from "../modules/tse/signing.service.js";

// Every 30 s, signs payments whose signature is still waiting or failed and
// due again (ADR-0005). Runs only where ENABLE_JOBS=true (src/server.js). A
// run never overlaps the one before it.
export const createTseSweep = ({
  intervalMs = 30_000,
  batchSize = 50,
  maxRetries = MAX_AUTO_RETRIES,
  now = () => new Date(),
  findDue = findDuePayments,
  sign = signPayment,
} = {}) => {
  let timer = null;
  let running = null;
  let stopping = false;

  const run = async () => {
    const due = await findDue({ now: now(), limit: batchSize, maxRetries });
    for (const { _id: paymentId } of due) {
      if (stopping) break;
      try {
        await sign(paymentId);
      } catch (error) {
        logger.error({ paymentId: String(paymentId), err: error }, "TSE sweep could not sign a payment");
        captureException(error);
      }
    }
    return { skipped: false, attempted: due.length };
  };

  const runOnce = async () => {
    if (running) return { skipped: true };
    running = run();
    try {
      return await running;
    } finally {
      running = null;
    }
  };

  const tick = () => {
    runOnce().catch((error) => {
      logger.error({ err: error }, "TSE sweep failed");
      captureException(error);
    });
  };

  return {
    runOnce,
    start() {
      if (timer) return;
      stopping = false;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running.catch(() => {});
    },
  };
};
