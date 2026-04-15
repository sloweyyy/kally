/**
 * Slack user lookup with in-memory caching.
 *
 * Resolves a Slack user id (U0XXX) to the user's email (and display name)
 * by calling `users.info` on the Slack Web API with the bot token.
 *
 * Cache: one entry per uid, TTL 24h (matches the expected churn rate —
 * email changes are rare, team changes are usually captured in a bot-token
 * rotation anyway).
 *
 * Requires Slack bot scope `users:read.email`. Without that scope, Slack
 * returns the user profile without the `email` field and we degrade to
 * `{ id, display_name }` without breaking.
 */

import { createLogger, logInfo, logWarn, logError } from "@kally/common";

const log = createLogger("slack-users");

export interface SlackUser {
  id: string;
  email?: string;
  display_name?: string;
}

export interface SlackUserResolver {
  (uid: string): Promise<SlackUser | undefined>;
}

interface CacheEntry {
  user: SlackUser;
  expiresAt: number;
}

/** Default cache TTL: 24 hours. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Response shape from Slack users.info. */
interface SlackUsersInfoResponse {
  ok: boolean;
  error?: string;
  user?: {
    id: string;
    name?: string;
    real_name?: string;
    profile?: {
      email?: string;
      display_name?: string;
      real_name?: string;
    };
  };
}

export interface CreateResolverOptions {
  /** Slack bot token (xoxb-...). */
  token: string;
  /** Cache TTL in ms. Defaults to 24h. */
  ttlMs?: number;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override Slack API base URL for tests. */
  apiBase?: string;
}

/**
 * Create a resolver. Returns a function that looks up a Slack user id and
 * returns `{id, email?, display_name?}` — undefined when unresolvable.
 *
 * Negative results (404, auth failures, etc.) are NOT cached; we retry on
 * every call. Positive results are cached for `ttlMs`.
 */
export function createSlackUserResolver(opts: CreateResolverOptions): SlackUserResolver {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? "https://slack.com/api";
  const cache = new Map<string, CacheEntry>();

  return async function resolveUser(uid: string): Promise<SlackUser | undefined> {
    if (!uid) return undefined;
    if (!opts.token) return undefined;

    const now = Date.now();
    const hit = cache.get(uid);
    if (hit && hit.expiresAt > now) return hit.user;

    try {
      const res = await fetchImpl(`${apiBase}/users.info?user=${encodeURIComponent(uid)}`, {
        headers: { Authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        logWarn(log, "users_info_http_error", { uid, status: res.status });
        return undefined;
      }
      const body = (await res.json()) as SlackUsersInfoResponse;
      if (!body.ok || !body.user) {
        logWarn(log, "users_info_api_error", { uid, error: body.error });
        return undefined;
      }
      const email = body.user.profile?.email;
      const display_name =
        body.user.profile?.display_name ||
        body.user.profile?.real_name ||
        body.user.real_name ||
        body.user.name;
      const user: SlackUser = {
        id: body.user.id,
        ...(email ? { email } : {}),
        ...(display_name ? { display_name } : {}),
      };
      cache.set(uid, { user, expiresAt: now + ttl });
      logInfo(log, "users_info_resolved", {
        uid,
        hasEmail: Boolean(email),
        hasDisplayName: Boolean(display_name),
      });
      return user;
    } catch (err) {
      logError(log, "users_info_fetch_error", err instanceof Error ? err.message : String(err), {
        uid,
      });
      return undefined;
    }
  };
}

/** No-op resolver for tests / unconfigured environments. Always returns undefined. */
export const nullSlackUserResolver: SlackUserResolver = async () => undefined;
