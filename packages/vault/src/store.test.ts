import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultStore } from "./store.js";

const KEY = randomBytes(32).toString("base64");

describe("VaultStore", () => {
  let dir: string;
  let filePath: string;
  let store: VaultStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kally-vault-"));
    filePath = join(dir, "kally.json");
    store = new VaultStore({ filePath, masterKey: KEY });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file with an empty creds map on first use", () => {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.creds).toEqual({});
  });

  it("round-trips a put + get for a single record", async () => {
    await store.put("U123", "salesforce", JSON.stringify({ username: "a@b.com", pass: "x" }));
    const back = await store.get("U123", "salesforce");
    expect(back).toBe(JSON.stringify({ username: "a@b.com", pass: "x" }));
  });

  it("returns undefined for a missing record", async () => {
    expect(await store.get("U_NOPE", "salesforce")).toBeUndefined();
  });

  it("overwrites on put and preserves created_at", async () => {
    await store.put("U123", "salesforce", JSON.stringify({ v: 1 }));
    // Small delay so updated_at diverges.
    await new Promise((r) => setTimeout(r, 10));
    await store.put("U123", "salesforce", JSON.stringify({ v: 2 }));

    const state = JSON.parse(readFileSync(filePath, "utf8"));
    const rec = state.creds["U123:salesforce"];
    expect(rec.created_at).toBeDefined();
    expect(rec.updated_at).toBeDefined();
    expect(rec.updated_at).not.toBe(rec.created_at);
    // Fresh decrypt returns the latest.
    expect(await store.get("U123", "salesforce")).toBe(JSON.stringify({ v: 2 }));
  });

  it("isolates records by (user, provider)", async () => {
    await store.put("U1", "salesforce", JSON.stringify({ user: "a" }));
    await store.put("U2", "salesforce", JSON.stringify({ user: "b" }));
    await store.put("U1", "atlassian", JSON.stringify({ email: "a@x.com" }));

    expect(await store.get("U1", "salesforce")).toContain("a");
    expect(await store.get("U2", "salesforce")).toContain("b");
    expect(await store.get("U1", "atlassian")).toContain("a@x.com");
  });

  it("delete removes the record and returns true", async () => {
    await store.put("U1", "salesforce", JSON.stringify({}));
    expect(await store.delete("U1", "salesforce")).toBe(true);
    expect(await store.get("U1", "salesforce")).toBeUndefined();
  });

  it("delete returns false when the record was missing", async () => {
    expect(await store.delete("U_GHOST", "salesforce")).toBe(false);
  });

  it("listByUser returns metadata (no ciphertext) for one user's records, sorted", async () => {
    await store.put("U1", "atlassian", JSON.stringify({ email: "a@b.com" }));
    await store.put("U1", "salesforce", JSON.stringify({ v: 1 }));
    await store.put("U2", "salesforce", JSON.stringify({ v: 1 }));
    const rows = await store.listByUser("U1");
    expect(rows).toHaveLength(2);
    expect(rows[0].provider).toBe("atlassian");
    expect(rows[1].provider).toBe("salesforce");
    // Guard against accidental ciphertext leakage.
    expect(JSON.stringify(rows)).not.toContain("iv");
    expect(JSON.stringify(rows)).not.toContain("ciphertext");
  });

  it("listAll returns every record's metadata", async () => {
    await store.put("U1", "salesforce", JSON.stringify({}));
    await store.put("U2", "atlassian", JSON.stringify({ email: "x@y.com" }));
    const rows = await store.listAll();
    expect(rows).toHaveLength(2);
    const keys = rows.map((r) => `${r.slack_uid}:${r.provider}`);
    expect(keys).toEqual(["U1:salesforce", "U2:atlassian"]);
  });

  it("persists across store instances (reopen)", async () => {
    await store.put("U1", "salesforce", JSON.stringify({ v: 42 }));
    const reopened = new VaultStore({ filePath, masterKey: KEY });
    expect(await reopened.get("U1", "salesforce")).toBe(JSON.stringify({ v: 42 }));
  });

  it("throws on version mismatch (future upgrade safety)", async () => {
    await store.put("U1", "salesforce", JSON.stringify({}));
    // Hand-edit the file to simulate a future format.
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    raw.version = 99;
    require("node:fs").writeFileSync(filePath, JSON.stringify(raw));
    const stale = new VaultStore({ filePath, masterKey: KEY });
    await expect(stale.get("U1", "salesforce")).rejects.toThrow(/version mismatch/);
  });

  it("serializes concurrent writes via mutex (no lost updates)", async () => {
    // 20 parallel puts to the same key — final state must be exactly one
    // of them, not a garbled merge.
    const writes = Array.from({ length: 20 }, (_, i) =>
      store.put("U1", "salesforce", JSON.stringify({ n: i })),
    );
    await Promise.all(writes);
    const final = JSON.parse((await store.get("U1", "salesforce"))!);
    expect(typeof final.n).toBe("number");
    expect(final.n).toBeGreaterThanOrEqual(0);
    expect(final.n).toBeLessThan(20);
  });
});
