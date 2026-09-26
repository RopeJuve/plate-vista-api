import pino from "pino";

export const capturedLogs = [];

export const clearCapturedLogs = () => {
  capturedLogs.length = 0;
};

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: ["password", "req.headers.authorization", "*.password"],
  hooks: {
    logMethod(inputArgs, method, level) {
      if (process.env.NODE_ENV === "test" && this.levelVal <= level) {
        capturedLogs.push(inputArgs[0]);
      }
      return method.apply(this, inputArgs);
    },
  },
});

let sentry = null;

export const initSentry = async () => {
  if (!process.env.SENTRY_DSN || sentry) return;
  const Sentry = await import("@sentry/node");
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0 });
  sentry = Sentry;
};

export const captureException = (error) => {
  if (sentry) sentry.captureException(error);
};
