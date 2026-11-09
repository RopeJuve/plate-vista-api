import { captureException, logger } from "../shared/logger.js";
import { findDueSignatures, MAX_AUTO_RETRIES, sign as signTarget } from "../modules/tse/signing.service.js";

// Every 30 s, signs payments and orders (with their corrections) whose
// signature is still waiting or failed and due again (ADR-0005). Runs only where ENABLE_JOBS=true (src/server.js). A
// run never overlaps the one before it.
export const createTseSweep = ({
  intervalMs = 30_000,
  batchSize = 50,
  maxRetries = MAX_AUTO_RETRIES,
  now = () => new Date(),
  findDue = findDueSignatures,
  sign = signTarget,
} = {}) => {
  let timer = null;
  let running = null;
  let stopping = false;

  const run = async () => {
    const due = await findDue({ now: now(), limit: batchSize, maxRetries });
    for (const target of due) {
      if (stopping) break;
      try {
        await sign(target);
      } catch (error) {
        logger.error({ kind: target.kind, id: String(target.id), err: error }, "TSE sweep could not sign");
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
