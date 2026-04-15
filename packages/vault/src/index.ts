/**
 * Vault HTTP server — stores per-user encrypted credentials.
 *
 * Access control:
 * - All requests must carry `Authorization: Bearer <KALLY_VAULT_TOKEN>`.
 *   The token is a shared secret between the vault and its callers
 *   (gateway, later proxy). Defense in depth: the vault also only binds
 *   to the internal Docker network — not exposed on host.
 * - `x-kally-actor` identifies the calling service for audit. Not
 *   authenticated beyond the bearer token, but useful for tracing who
 *   did what.
 * - `x-kally-call-purpose` is free-text why (e.g. "sf_fetch_case"). Lands
 *   in the audit log, never mutates behavior.
 *
 * Endpoints:
 *   GET    /health
 *   GET    /creds/:slack_uid/:provider       → 200 {creds} | 404
 *   PUT    /creds/:slack_uid/:provider       body: {creds} → 204
 *   DELETE /creds/:slack_uid/:provider       → 204 | 404
 *   GET    /creds/:slack_uid                 → 200 {providers: [...]}
 *
 * The caller that decrypts sees plaintext. The caller is trusted.
 */

import express, { type Request, type Response } from "express";
import { createLogger, logInfo, logWarn, logError } from "@kally/common";
import { VaultStore } from "./store.js";
import { AuditLog } from "./audit.js";
import { isProviderName, validateCred } from "./providers.js";

const log = createLogger("vault");

const PORT = parseInt(process.env.PORT || "3006", 10);
const VAULT_FILE = process.env.KALLY_VAULT_FILE || "/workspace/vault/kally.json";
const AUDIT_FILE = process.env.KALLY_VAULT_AUDIT_FILE || "/workspace/vault/audit.jsonl";
const MASTER_KEY = process.env.KALLY_VAULT_MASTER_KEY || "";
const VAULT_TOKEN = process.env.KALLY_VAULT_TOKEN || "";

// Fail-fast: bad config should crash the container rather than quietly
// accept requests with a broken vault. Both env vars are mandatory.
if (!MASTER_KEY) {
  logError(log, "startup_config_error", "KALLY_VAULT_MASTER_KEY is not set", {});
  process.exit(1);
}
if (!VAULT_TOKEN) {
  logError(log, "startup_config_error", "KALLY_VAULT_TOKEN is not set", {});
  process.exit(1);
}

let store: VaultStore;
try {
  store = new VaultStore({ filePath: VAULT_FILE, masterKey: MASTER_KEY });
} catch (err) {
  logError(log, "startup_config_error", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const audit = new AuditLog(AUDIT_FILE);

// ── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "32kb" }));

function nowIso(): string {
  return new Date().toISOString();
}

/** Shared bearer check. Timing-safe to avoid leaking length. */
function authOk(req: Request): boolean {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return false;
  const presented = h.slice(7);
  if (presented.length !== VAULT_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ VAULT_TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

function requireAuth(req: Request, res: Response): boolean {
  if (!authOk(req)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

function actorFrom(req: Request): string | undefined {
  const a = req.headers["x-kally-actor"];
  return typeof a === "string" ? a : undefined;
}

function purposeFrom(req: Request): string | undefined {
  const p = req.headers["x-kally-call-purpose"];
  return typeof p === "string" ? p : undefined;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "vault" });
});

// --- GET /creds/:slack_uid/:provider — decrypt and return the record ---
app.get("/creds/:slack_uid/:provider", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { slack_uid, provider } = req.params;
  const actor = actorFrom(req);
  const purpose = purposeFrom(req);

  if (!isProviderName(provider)) {
    audit.write({
      ts: nowIso(),
      action: "get",
      slack_uid,
      provider,
      actor,
      purpose,
      ok: false,
      error: "unknown_provider",
    });
    res.status(400).json({ error: `unknown provider: ${provider}` });
    return;
  }

  try {
    const plaintext = await store.get(slack_uid, provider);
    if (plaintext === undefined) {
      audit.write({
        ts: nowIso(),
        action: "get",
        slack_uid,
        provider,
        actor,
        purpose,
        ok: false,
        error: "not_found",
      });
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = JSON.parse(plaintext);
    audit.write({
      ts: nowIso(),
      action: "get",
      slack_uid,
      provider,
      actor,
      purpose,
      ok: true,
    });
    logInfo(log, "cred_read", { slack_uid, provider, actor, purpose });
    res.json({ slack_uid, provider, creds: parsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audit.write({
      ts: nowIso(),
      action: "get",
      slack_uid,
      provider,
      actor,
      purpose,
      ok: false,
      error: "decrypt_failed",
    });
    logError(log, "cred_read_failed", message, { slack_uid, provider });
    res.status(500).json({ error: "decrypt_failed" });
  }
});

// --- PUT /creds/:slack_uid/:provider — encrypt and store ---
app.put("/creds/:slack_uid/:provider", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { slack_uid, provider } = req.params;
  const actor = actorFrom(req);

  if (!isProviderName(provider)) {
    res.status(400).json({ error: `unknown provider: ${provider}` });
    return;
  }

  const payload = (req.body as { creds?: unknown })?.creds;
  if (payload === undefined) {
    res.status(400).json({ error: "missing body field: creds" });
    return;
  }

  const validation = validateCred(provider, payload);
  if (!validation.ok) {
    audit.write({
      ts: nowIso(),
      action: "put",
      slack_uid,
      provider,
      actor,
      ok: false,
      error: "validation_failed",
    });
    res.status(400).json({ error: `invalid creds: ${validation.error}` });
    return;
  }

  try {
    await store.put(slack_uid, provider, JSON.stringify(validation.value));
    audit.write({ ts: nowIso(), action: "put", slack_uid, provider, actor, ok: true });
    logInfo(log, "cred_written", { slack_uid, provider, actor });
    res.status(204).end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audit.write({
      ts: nowIso(),
      action: "put",
      slack_uid,
      provider,
      actor,
      ok: false,
      error: "write_failed",
    });
    logError(log, "cred_write_failed", message, { slack_uid, provider });
    res.status(500).json({ error: "write_failed" });
  }
});

// --- DELETE /creds/:slack_uid/:provider — revoke a record ---
app.delete("/creds/:slack_uid/:provider", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { slack_uid, provider } = req.params;
  const actor = actorFrom(req);

  if (!isProviderName(provider)) {
    res.status(400).json({ error: `unknown provider: ${provider}` });
    return;
  }

  try {
    const removed = await store.delete(slack_uid, provider);
    audit.write({
      ts: nowIso(),
      action: "delete",
      slack_uid,
      provider,
      actor,
      ok: removed,
      error: removed ? undefined : "not_found",
    });
    if (!removed) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    logInfo(log, "cred_deleted", { slack_uid, provider, actor });
    res.status(204).end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(log, "cred_delete_failed", message, { slack_uid, provider });
    res.status(500).json({ error: "delete_failed" });
  }
});

// --- GET /creds/:slack_uid — list providers a user has connected ---
app.get("/creds/:slack_uid", async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { slack_uid } = req.params;
  const actor = actorFrom(req);
  try {
    const rows = await store.listByUser(slack_uid);
    audit.write({ ts: nowIso(), action: "list", slack_uid, actor, ok: true });
    res.json({ slack_uid, providers: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(log, "cred_list_failed", message, { slack_uid });
    res.status(500).json({ error: "list_failed" });
  }
});

app.listen(PORT, () => {
  logInfo(log, "vault_started", { port: PORT, vaultFile: VAULT_FILE, auditFile: AUDIT_FILE });
});
