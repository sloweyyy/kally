/**
 * Authenticated symmetric encryption for vault records.
 *
 * Algorithm: AES-256-GCM
 *   - 32-byte key (the vault master key, base64 in env)
 *   - 12-byte random IV per record (unique per encrypt, standard for GCM)
 *   - 16-byte authentication tag (detects tampering)
 *
 * Record shape on disk:
 *   { iv: <base64>, ciphertext: <base64>, tag: <base64> }
 *
 * GCM is the right pick here: it's a single pass, authenticated, and ships
 * with Node's built-in `crypto` so we don't drag in libsodium just for this.
 * Tampering with any of {iv, ciphertext, tag} makes `decrypt` throw. That's
 * exactly the safety property we want — a corrupted vault file should blow
 * up loudly rather than return garbage.
 *
 * Key rotation: decrypt the record with the old key, re-encrypt with the new
 * key, write back. The `rotate` helper below exists for that migration but
 * is not wired to an endpoint yet (rotation is a runbook, not a public API).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedRecord {
  iv: string; // base64
  ciphertext: string; // base64
  tag: string; // base64
}

/** Parse a base64-encoded 32-byte master key. Throws on wrong length. */
export function parseMasterKey(b64: string): Buffer {
  if (!b64) {
    throw new Error("Master key is empty. Generate one: `openssl rand -base64 32`");
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Master key must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        `Generate one: \`openssl rand -base64 32\``,
    );
  }
  return key;
}

/** Encrypt a string plaintext into an EncryptedRecord with a fresh IV. */
export function encrypt(plaintext: string, key: Buffer): EncryptedRecord {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error(`Auth tag length mismatch: ${tag.length}`);
  }
  return {
    iv: iv.toString("base64"),
    ciphertext: enc.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/** Decrypt an EncryptedRecord back into the original plaintext. Throws if
 *  tampered, truncated, or encrypted with a different key. */
export function decrypt(record: EncryptedRecord, key: Buffer): string {
  const iv = Buffer.from(record.iv, "base64");
  const tag = Buffer.from(record.tag, "base64");
  const ct = Buffer.from(record.ciphertext, "base64");
  if (iv.length !== IV_BYTES) throw new Error(`IV length mismatch: ${iv.length}`);
  if (tag.length !== TAG_BYTES) throw new Error(`Auth tag length mismatch: ${tag.length}`);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString("utf8");
}

/** Re-encrypt a record with a new key (for master-key rotation). */
export function rotate(record: EncryptedRecord, oldKey: Buffer, newKey: Buffer): EncryptedRecord {
  const plain = decrypt(record, oldKey);
  return encrypt(plain, newKey);
}
