import { Schema, model } from "mongoose";

// Only the SHA-256 of a refresh token is stored. Every rotation adds a row to
// the same family; presenting an already-used token revokes the whole family.
const refreshTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    subjectType: { type: String, enum: ["employee", "user"], required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RefreshToken = model("RefreshToken", refreshTokenSchema);
export default RefreshToken;
