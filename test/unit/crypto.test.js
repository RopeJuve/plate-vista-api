import test from "node:test";
import assert from "node:assert/strict";
import { decrypt, encrypt, isValidKey } from "../../src/shared/crypto.js";

const key = Buffer.alloc(32, 1).toString("base64");
const otherKey = Buffer.alloc(32, 2).toString("base64");

test("encrypt and decrypt round trip as iv:tag:ciphertext", () => {
  const sealed = encrypt("123456-pin", key);
  const parts = sealed.split(":");
  assert.equal(parts.length, 3);
  for (const part of parts) assert.match(part, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(sealed.includes("123456-pin"), false);
  assert.equal(decrypt(sealed, key), "123456-pin");
  assert.equal(decrypt(encrypt("", key), key), "");
});

test("each encryption uses a fresh random IV", () => {
  const first = encrypt("same", key);
  const second = encrypt("same", key);
  assert.notEqual(first, second);
  assert.notEqual(first.split(":")[0], second.split(":")[0]);
});

test("a tampered value throws", () => {
  const [iv, tag, data] = encrypt("secret puk", key).split(":");
  const flipped = Buffer.from(data, "base64");
  flipped[0] ^= 1;
  assert.throws(() => decrypt(`${iv}:${tag}:${flipped.toString("base64")}`, key));
  const badTag = Buffer.from(tag, "base64");
  badTag[0] ^= 1;
  assert.throws(() => decrypt(`${iv}:${badTag.toString("base64")}:${data}`, key));
  assert.throws(() => decrypt("garbage", key));
});

test("the wrong key throws", () => {
  assert.throws(() => decrypt(encrypt("secret", key), otherKey));
});

test("the key comes from ENCRYPTION_KEY and must be 32 bytes", () => {
  const previous = process.env.ENCRYPTION_KEY;
  try {
    process.env.ENCRYPTION_KEY = key;
    assert.equal(decrypt(encrypt("from env")), "from env");
    delete process.env.ENCRYPTION_KEY;
    assert.throws(() => encrypt("x"), /ENCRYPTION_KEY/);
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previous;
  }
  assert.equal(isValidKey(key), true);
  assert.equal(isValidKey(Buffer.alloc(31).toString("base64")), false);
  assert.equal(isValidKey("%%%"), false);
  assert.throws(() => encrypt("x", Buffer.alloc(16).toString("base64")), /ENCRYPTION_KEY/);
});
