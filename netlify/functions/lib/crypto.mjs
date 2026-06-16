/**
 * lib/crypto.mjs — AES-256-GCM secret encryption/decryption
 */
import crypto from "node:crypto";
import { getEnv } from "./env.mjs";

/**
 * Derives a 256-bit AES key from TOKEN_ENCRYPTION_KEY.
 *
 * Fails closed: throws if the key is missing or too weak. We deliberately do
 * NOT fall back to the JWT secret — reusing the signing secret for at-rest
 * encryption collapses two independent security domains, so a single leak or
 * misconfiguration would compromise both.
 *
 * Accepts either a base-64 encoded 32-byte key (preferred —
 * `openssl rand -base64 32`) or a passphrase of at least 32 bytes.
 */
function getEncryptionKey() {
  const raw = getEnv("TOKEN_ENCRYPTION_KEY", "").trim();
  if (!raw) {
    throw new Error(
      "Missing TOKEN_ENCRYPTION_KEY environment variable. " +
        "Generate one with: openssl rand -base64 32"
    );
  }
  if (/^[A-Za-z0-9+/=]+$/.test(raw)) {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length >= 32) return decoded.subarray(0, 32);
  }
  if (Buffer.byteLength(raw, "utf8") >= 32) {
    return crypto.createHash("sha256").update(raw).digest();
  }
  throw new Error(
    "TOKEN_ENCRYPTION_KEY is too weak: provide a base-64 encoded 32-byte key " +
      "(openssl rand -base64 32) or a passphrase of at least 32 characters."
  );
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * The output format is `enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>`.
 * Passing an empty string returns an empty string (no-op).
 *
 * @param {string} plainText
 * @returns {string} Encrypted token, or "" if input is empty
 */
export function encryptSecret(plainText) {
  const input = (plainText || "").toString();
  if (!input) return "";
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(input, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypt a value produced by `encryptSecret`.
 * Returns the original plaintext, or "" on any failure (wrong key, tampered
 * ciphertext, unrecognised format, etc.).
 * Values that do not start with "enc:v1:" are returned as-is, allowing
 * unencrypted legacy values to be read transparently.
 *
 * @param {string} cipherText
 * @returns {string}
 */
export function decryptSecret(cipherText) {
  const input = (cipherText || "").toString();
  if (!input) return "";
  if (!input.startsWith("enc:v1:")) return input;

  const parts = input.split(":");
  if (parts.length !== 5) return "";

  try {
    const iv = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const encrypted = Buffer.from(parts[4], "base64");
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return "";
  }
}
