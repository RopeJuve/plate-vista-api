import { logger } from "./logger.js";

const RENDER_TIMEOUT_MS = 1500;

// Vercel cannot keep working after it replied, so it hands work to the Render
// server over the internal channel (ADR-0005).
export const runsOnVercel = () => (process.env.DEPLOY_TARGET || "local") === "vercel";

// Fire-and-forget POST to Render, secured with the internal secret and given
// up after 1.5 s. A failure only logs (never the secret); returns false when
// Render is not configured, so the caller can say what that means for it.
export const postToRender = (path, body, logFields = {}) => {
  const base = process.env.RENDER_INTERNAL_URL;
  const secret = process.env.INTERNAL_SECRET;
  if (!base || !secret) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  Promise.resolve()
    .then(() =>
      fetch(new URL(path, base), {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": secret },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    )
    .then((response) => {
      if (!response.ok) logger.warn({ ...logFields, path, status: response.status }, "internal call rejected");
    })
    .catch((error) => {
      logger.warn({ ...logFields, path, err: error?.message }, "internal call failed");
    })
    .finally(() => clearTimeout(timer));
  return true;
};
