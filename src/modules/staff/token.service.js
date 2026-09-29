import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { ACCESS_TOKEN_TTL_SECONDS, generateToken } from "../../shared/auth.js";
import { AppError } from "../../shared/errors.js";
import { parseOrThrow } from "../../shared/validate.js";
import Employee from "./employee.model.js";
import RefreshToken from "./refreshToken.model.js";
import User from "./user.model.js";

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const refreshSchema = z.object({
  refreshToken: z.string().min(1, "refreshToken is required").max(200),
});

const hashToken = (token) => createHash("sha256").update(token).digest("hex");

const invalidToken = () => new AppError("UNAUTHORIZED", "Invalid refresh token", 401);

const subjectTypeOf = (account) =>
  account.constructor?.modelName === "Employee" ? "employee" : "user";

// Reload the account on every refresh so a deleted employee or a changed
// position takes effect at the next refresh, not only when the old JWT expires.
const loadAccount = async ({ subjectType, subjectId }) => {
  if (subjectType === "employee") {
    return Employee.findOne({ _id: subjectId }).setOptions({ skipTenant: true });
  }
  return User.findById(subjectId);
};

const revokeFamily = (familyId, at = new Date()) =>
  RefreshToken.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: at } });

export const issueTokens = async (account, familyId = randomUUID()) => {
  const refreshToken = randomBytes(48).toString("base64url");
  await RefreshToken.create({
    tokenHash: hashToken(refreshToken),
    familyId,
    subjectType: subjectTypeOf(account),
    subjectId: account._id,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return {
    tokenType: "Bearer",
    accessToken: generateToken(account),
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken,
  };
};

export const rotateRefreshToken = async (input) => {
  const { refreshToken } = parseOrThrow(refreshSchema, input);
  const tokenHash = hashToken(refreshToken);
  const now = new Date();
  // Marking the token used in the same write that checks it means two
  // parallel refreshes with one token cannot both succeed.
  const record = await RefreshToken.findOneAndUpdate(
    { tokenHash, usedAt: null, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true }
  );
  if (!record) {
    const known = await RefreshToken.findOne({ tokenHash });
    if (known?.usedAt) await revokeFamily(known.familyId, now);
    throw invalidToken();
  }
  const account = await loadAccount(record);
  if (!account) {
    await revokeFamily(record.familyId, now);
    throw invalidToken();
  }
  return issueTokens(account, record.familyId);
};

export const revokeRefreshToken = async (input) => {
  const { refreshToken } = parseOrThrow(refreshSchema, input);
  const known = await RefreshToken.findOne({ tokenHash: hashToken(refreshToken) });
  if (known) await revokeFamily(known.familyId);
};
