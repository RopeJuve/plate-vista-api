import { z } from "zod";

const emptyToUndefined = (value) =>
  value == null || value === "" ? undefined : value;

const schema = z
  .object({
    JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
    MONGO_DB_URL: z.string().min(1, "MONGO_DB_URL is required"),
    PORT: z.coerce.number().int().positive().default(8080),
    CORS_ORIGIN: z.string().optional(),
    DEPLOY_TARGET: z.enum(["local", "vercel", "render"]).default("local"),
    RENDER_INTERNAL_URL: z.string().url().optional(),
    INTERNAL_SECRET: z.string().min(16).optional(),
    NODE_ENV: z.string().optional(),
    LOG_LEVEL: z.string().optional(),
    SENTRY_DSN: z.string().optional(),
    TRUST_PROXY: z.coerce.number().int().min(0).optional(),
    ALLOW_LEGACY_WS_TOKEN: z.enum(["true", "false"]).default("true"),
  })
  .superRefine((value, ctx) => {
    if (value.DEPLOY_TARGET !== "local" && !value.CORS_ORIGIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGIN"],
        message: `CORS_ORIGIN is required when DEPLOY_TARGET=${value.DEPLOY_TARGET}`,
      });
    }
    if (value.DEPLOY_TARGET === "vercel") {
      if (!value.RENDER_INTERNAL_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["RENDER_INTERNAL_URL"],
          message: "RENDER_INTERNAL_URL is required when DEPLOY_TARGET=vercel",
        });
      }
      if (!value.INTERNAL_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["INTERNAL_SECRET"],
          message: "INTERNAL_SECRET is required when DEPLOY_TARGET=vercel",
        });
      }
    }
    if (value.DEPLOY_TARGET === "render" && !value.INTERNAL_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["INTERNAL_SECRET"],
        message: "INTERNAL_SECRET is required when DEPLOY_TARGET=render",
      });
    }
  });

export const loadEnv = (source = process.env) => {
  const normalized = {
    JWT_SECRET: source.JWT_SECRET,
    MONGO_DB_URL: source.MONGO_DB_URL,
    PORT: emptyToUndefined(source.PORT),
    CORS_ORIGIN: emptyToUndefined(source.CORS_ORIGIN),
    DEPLOY_TARGET: emptyToUndefined(source.DEPLOY_TARGET),
    RENDER_INTERNAL_URL: emptyToUndefined(source.RENDER_INTERNAL_URL),
    INTERNAL_SECRET: emptyToUndefined(source.INTERNAL_SECRET),
    NODE_ENV: emptyToUndefined(source.NODE_ENV),
    LOG_LEVEL: emptyToUndefined(source.LOG_LEVEL),
    SENTRY_DSN: emptyToUndefined(source.SENTRY_DSN),
    TRUST_PROXY: emptyToUndefined(source.TRUST_PROXY),
    ALLOW_LEGACY_WS_TOKEN: emptyToUndefined(source.ALLOW_LEGACY_WS_TOKEN),
  };
  const parsed = schema.safeParse(normalized);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    const error = new Error(`Invalid environment: ${message}`);
    error.name = "ConfigError";
    throw error;
  }
  return {
    ...parsed.data,
    port: parsed.data.PORT,
    corsOrigins: parsed.data.CORS_ORIGIN
      ? parsed.data.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean)
      : [],
  };
};
