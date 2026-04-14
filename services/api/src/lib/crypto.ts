import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be 64 hex characters (32 bytes) for AES-256",
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return Buffer.concat([iv, enc]).toString("base64url");
}

export function decryptSecret(payload: string): string {
  const key = getKey();
  const raw = Buffer.from(payload, "base64url");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(raw.length - AUTH_TAG_LEN);
  const data = raw.subarray(IV_LEN, raw.length - AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}
