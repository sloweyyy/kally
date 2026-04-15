/**
 * HTTP client for the vault service.
 *
 * Thin wrapper around fetch. One bearer token shared across calls, actor
 * and purpose passed per-call so the audit log can tell which code path
 * read/wrote a credential.
 *
 * Errors are returned as typed results, not thrown — the caller decides
 * what to do on 4xx vs 5xx vs network failure. The gateway needs to
 * translate these into user-facing Slack messages ("try again" vs
 * "missing creds, enroll").
 */

import { logError, logInfo } from "./logger.js";
import type { Logger } from "./logger.js";

export interface VaultClientConfig {
  baseUrl: string;
  token: string;
  actor: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export type VaultProvider = "salesforce" | "atlassian";

export interface VaultGetResult<T = unknown> {
  ok: true;
  slack_uid: string;
  provider: VaultProvider;
  creds: T;
}

export interface VaultErr {
  ok: false;
  status: number;
  error: string;
}

export type VaultGetResponse<T = unknown> = VaultGetResult<T> | VaultErr;

export interface VaultClient {
  get<T = unknown>(
    slack_uid: string,
    provider: VaultProvider,
    purpose: string,
  ): Promise<VaultGetResponse<T>>;
  put(
    slack_uid: string,
    provider: VaultProvider,
    creds: Record<string, unknown>,
  ): Promise<{ ok: true } | VaultErr>;
  delete(slack_uid: string, provider: VaultProvider): Promise<{ ok: true } | VaultErr>;
  listByUser(
    slack_uid: string,
  ): Promise<
    | { ok: true; providers: Array<{ provider: string; created_at: string; updated_at: string }> }
    | VaultErr
  >;
}

/**
 * Notify the proxy to evict cached per-user upstream connections for a
 * user after their credentials change. Without this, a user's next tool
 * call after `/kally connect` could reuse a stale MCP session opened
 * with the old credentials (up to 30 min of idle TTL).
 *
 * The proxy accepts the same vault bearer token. Best-effort — a failure
 * here doesn't break enrollment; it just means the stale cache lives
 * until TTL expires.
 */
export async function invalidateProxyUserConnections(
  proxyBaseUrl: string,
  vaultToken: string,
  slack_uid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!proxyBaseUrl || !vaultToken) return;
  try {
    await fetchImpl(`${proxyBaseUrl.replace(/\/$/, "")}/user-connections/${slack_uid}/invalidate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${vaultToken}` },
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // best-effort, swallow
  }
}

export function createVaultClient(config: VaultClientConfig): VaultClient {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseHeaders = {
    Authorization: `Bearer ${config.token}`,
    "x-kally-actor": config.actor,
  };

  return {
    async get(slack_uid, provider, purpose) {
      try {
        const res = await fetchImpl(`${baseUrl}/creds/${slack_uid}/${provider}`, {
          headers: { ...baseHeaders, "x-kally-call-purpose": purpose },
          signal: AbortSignal.timeout(5_000),
        });
        if (res.status === 404) return { ok: false, status: 404, error: "not_found" };
        if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
        const body = (await res.json()) as { slack_uid: string; provider: string; creds: unknown };
        return {
          ok: true,
          slack_uid: body.slack_uid,
          provider: body.provider as VaultProvider,
          creds: body.creds as never,
        };
      } catch (err) {
        if (config.logger)
          logError(
            config.logger,
            "vault_get_error",
            err instanceof Error ? err.message : String(err),
            {
              slack_uid,
              provider,
            },
          );
        return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async put(slack_uid, provider, creds) {
      try {
        const res = await fetchImpl(`${baseUrl}/creds/${slack_uid}/${provider}`, {
          method: "PUT",
          headers: { ...baseHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ creds }),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          if (config.logger)
            logInfo(config.logger, "vault_put_ok", { slack_uid, provider, status: res.status });
          return { ok: true };
        }
        return { ok: false, status: res.status, error: await res.text() };
      } catch (err) {
        return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async delete(slack_uid, provider) {
      try {
        const res = await fetchImpl(`${baseUrl}/creds/${slack_uid}/${provider}`, {
          method: "DELETE",
          headers: { ...baseHeaders },
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) return { ok: true };
        return { ok: false, status: res.status, error: await res.text() };
      } catch (err) {
        return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async listByUser(slack_uid) {
      try {
        const res = await fetchImpl(`${baseUrl}/creds/${slack_uid}`, {
          headers: { ...baseHeaders },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return { ok: false, status: res.status, error: await res.text() };
        const body = (await res.json()) as {
          slack_uid: string;
          providers: Array<{ provider: string; created_at: string; updated_at: string }>;
        };
        return { ok: true, providers: body.providers };
      } catch (err) {
        return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
