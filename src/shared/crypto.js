import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for secrets we must keep but never show (the TSE admin PIN/PUK).
// Stored as "iv:tag:ciphertext", each part base64. Errors never include the
// plaintext or the key.
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const decodeKey = (encoded) => {
  if (typeof encoded !== "string" || !BASE64.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length === 32 ? key : null;
};

export const isValidKey = (encoded) => decodeKey(encoded) !== null;

const keyFrom = (encoded = process.env.ENCRYPTION_KEY) => {
  const key = decodeKey(encoded);
  if (!key) throw new Error("ENCRYPTION_KEY must be base64 that decodes to 32 bytes");
  return key;
};

export const encrypt = (plain, encodedKey) => {
  const key = keyFrom(encodedKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(":");
};

export const decrypt = (sealed, encodedKey) => {
  const key = keyFrom(encodedKey);
  const parts = typeof sealed === "string" ? sealed.split(":") : [];
  if (parts.length !== 3) throw new Error("Encrypted value is malformed");
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64"));
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("Encrypted value is malformed");
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Encrypted value could not be decrypted");
  }
};
