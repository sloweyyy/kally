import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, parseMasterKey, rotate } from "./crypto.js";

const TEST_KEY_B64 = randomBytes(32).toString("base64");

describe("parseMasterKey", () => {
  it("parses a 32-byte base64 key", () => {
    const key = parseMasterKey(TEST_KEY_B64);
    expect(key.length).toBe(32);
  });

  it("throws on empty key", () => {
    expect(() => parseMasterKey("")).toThrow(/empty/);
  });

  it("throws on wrong length", () => {
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("encrypt/decrypt round-trip", () => {
  const key = parseMasterKey(TEST_KEY_B64);

  it("round-trips a simple string", () => {
    const plain = "hunter2";
    const ct = encrypt(plain, key);
    expect(decrypt(ct, key)).toBe(plain);
  });

  it("round-trips a large JSON blob with unicode", () => {
    const plain = JSON.stringify({
      username: "phuc.truong@katalon.com",
      password: "pässwörd🔒".repeat(50),
      nested: { a: [1, 2, 3], b: "emoji: 🎉" },
    });
    const ct = encrypt(plain, key);
    expect(decrypt(ct, key)).toBe(plain);
  });

  it("produces a different ciphertext + IV for the same plaintext (fresh IV per encrypt)", () => {
    const a = encrypt("same-plaintext", key);
    const b = encrypt("same-plaintext", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("throws on ciphertext tampering", () => {
    const ct = encrypt("secret", key);
    const tamperedBytes = Buffer.from(ct.ciphertext, "base64");
    tamperedBytes[0] ^= 0xff;
    const tampered = { ...ct, ciphertext: tamperedBytes.toString("base64") };
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("throws on auth tag tampering", () => {
    const ct = encrypt("secret", key);
    const tagBytes = Buffer.from(ct.tag, "base64");
    tagBytes[0] ^= 0xff;
    expect(() => decrypt({ ...ct, tag: tagBytes.toString("base64") }, key)).toThrow();
  });

  it("throws when decrypted with a different key", () => {
    const ct = encrypt("secret", key);
    const wrong = parseMasterKey(randomBytes(32).toString("base64"));
    expect(() => decrypt(ct, wrong)).toThrow();
  });
});

describe("rotate", () => {
  it("re-encrypts a record with a new key", () => {
    const oldKey = parseMasterKey(randomBytes(32).toString("base64"));
    const newKey = parseMasterKey(randomBytes(32).toString("base64"));
    const plain = "rotate-me";
    const oldCt = encrypt(plain, oldKey);
    const newCt = rotate(oldCt, oldKey, newKey);
    expect(decrypt(newCt, newKey)).toBe(plain);
    expect(() => decrypt(newCt, oldKey)).toThrow();
  });
});
