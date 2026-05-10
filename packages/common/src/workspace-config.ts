import { z } from "zod/v4";
import { WORKSPACE_REPOS_ROOT, isPathWithin } from "./paths.js";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import { createLogger, logWarn } from "./logger.js";
import { PROXY_NAMES } from "./proxies.js";

// --- Schema ---

const RepoConfigSchema = z.object({
  channels: z.array(z.string()).optional(),
  proxies: z.array(z.string()).optional(),
});

const OwnerConfigSchema = z.object({
  github_app_installation_id: z.number().int().positive(),
});

const MitmproxyRuleSchema = z
  .object({
    host: z.string().min(1).optional(),
    host_suffix: z.string().min(2).startsWith(".").optional(),
    path_prefix: z.string().min(1).startsWith("/").optional(),
    headers: z
      .record(z.string(), z.string())
      .refine(
        (headers) => Object.keys(headers).length > 0,
        '"headers" must contain at least one entry',
      ),
    readonly: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasHost = typeof value.host === "string";
    const hasHostSuffix = typeof value.host_suffix === "string";
    if (hasHost === hasHostSuffix) {
      ctx.addIssue({
        code: "custom",
        message: 'Exactly one of "host" or "host_suffix" is required',
        path: ["host"],
      });
    }
  });

const MitmproxyPassthroughHostSchema = z.string().refine((value) => {
  if (value.startsWith(".")) {
    return value.length > 1;
  }
  return !value.includes("/") && !value.includes(":") && value.length > 0;
}, "Passthrough entries must be an exact host or a suffix starting with '.'");

export const WorkspaceConfigSchema = z
  .object({
    repos: z.record(z.string(), RepoConfigSchema),
    owners: z.record(z.string(), OwnerConfigSchema).optional(),
    mitmproxy: z.array(MitmproxyRuleSchema).optional(),
    mitmproxy_passthrough: z.array(MitmproxyPassthroughHostSchema).optional(),
    /** Emails that count as Support team members (used by `access: "support"` proxies). */
    support_team_emails: z.array(z.string()).optional(),
    /** Email suffixes that count as Katalon (used by `access: "katalon"` proxies). */
    katalon_email_suffixes: z.array(z.string()).optional(),
  })
  .strict();

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type OwnerConfig = z.infer<typeof OwnerConfigSchema>;

export interface ProxyUpstream {
  url: string;
  headers?: Record<string, string>;
}

/** Per-proxy access policy.
 *   - "public":  no identity check (default when unset)
 *   - "katalon": user_email must end with one of katalon_email_suffixes
 *   - "support": user_email must be in support_team_emails
 */
export type AccessPolicy = "public" | "katalon" | "support";

export interface ProxyConfig {
  upstream: ProxyUpstream;
  allow: string[];
  approve: string[];
  /** Who can invoke this upstream. Defaults to "public" (no check). */
  access?: AccessPolicy;
  /** Whether to inject per-user credentials from the vault. */
  per_user_creds?: boolean;
  /** How per-user creds reach the upstream: as args field or per-user connection. */
  creds_injection?: "args" | "connection";
}

export interface AccessUser {
  user_id?: string;
  user_email?: string;
}

export type AccessDecision =
  | { ok: true }
  | { ok: false; reason: "unknown_user" | "not_support" | "not_katalon"; message: string };

/**
 * Decide whether a user may call this upstream. Returns a typed reason on
 * deny so the proxy can format a user-friendly Slack message.
 */
export function checkUserAccess(
  config: WorkspaceConfig,
  proxy: ProxyConfig,
  user: AccessUser,
): AccessDecision {
  const policy = proxy.access ?? "public";
  if (policy === "public") return { ok: true };

  if (!user.user_email) {
    return {
      ok: false,
      reason: "unknown_user",
      message:
        "Your Slack account isn't linked to an email Kally can see. Ask the admin " +
        "to grant the bot the `users:read.email` scope, then mention @Kally again.",
    };
  }

  const email = user.user_email.toLowerCase();

  if (policy === "katalon") {
    const suffixes = (config.katalon_email_suffixes ?? []).map((s) => s.toLowerCase());
    const ok = suffixes.some((s) => email.endsWith(s));
    if (!ok) {
      return {
        ok: false,
        reason: "not_katalon",
        message:
          "This tool is restricted to Katalon team members. Your account " +
          `(${user.user_email}) isn't recognized.`,
      };
    }
    return { ok: true };
  }

  // policy === "support"
  const team = new Set((config.support_team_emails ?? []).map((s) => s.toLowerCase()));
  if (!team.has(email)) {
    return {
      ok: false,
      reason: "not_support",
      message:
        `Salesforce tools are restricted to the Product Support team. ` +
        `Your account (${user.user_email}) isn't on the team list. ` +
        "Ping <@U0AB0BK0FMX> if you think this is wrong.",
    };
  }
  return { ok: true };
}

// --- Validator ---

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; data: WorkspaceConfig }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Validate an already-parsed config object. Aggregates all issues
 * (schema, duplicate channels, unknown proxies) before returning.
 */
export function validateWorkspaceConfig(parsed: unknown): ValidationResult {
  if (
    parsed &&
    typeof parsed === "object" &&
    Object.prototype.hasOwnProperty.call(parsed, "proxies")
  ) {
    return {
      ok: false,
      issues: [
        {
          path: "proxies",
          message:
            'Top-level "proxies" has moved to code (packages/common/src/proxies.ts). Remove it from config.json.',
        },
      ],
    };
  }

  const result = WorkspaceConfigSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => ({
        path: i.path.length > 0 ? i.path.join(".") : "(root)",
        message: i.message,
      })),
    };
  }

  const issues: ValidationIssue[] = [];

  const seen = new Map<string, string>(); // channel → repo
  for (const [repo, config] of Object.entries(result.data.repos)) {
    for (const channel of config.channels ?? []) {
      const existing = seen.get(channel);
      if (existing) {
        issues.push({
          path: `repos.${repo}.channels`,
          message: `Duplicate channel ID "${channel}" — already mapped to repo "${existing}"`,
        });
      } else {
        seen.set(channel, repo);
      }
    }
  }

  const proxyNames = new Set<string>(PROXY_NAMES);
  for (const [repo, repoConfig] of Object.entries(result.data.repos)) {
    for (const proxyRef of repoConfig.proxies ?? []) {
      if (!proxyNames.has(proxyRef)) {
        issues.push({
          path: `repos.${repo}.proxies`,
          message: `Unknown proxy "${proxyRef}". Available proxies: ${PROXY_NAMES.join(", ")}`,
        });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, data: result.data };
}

// --- Loader ---

const REPOS_PREFIX = "/workspace/repos";

/**
 * Load and validate workspace config from a JSON file.
 * Throws on: missing file, invalid JSON, schema violation, duplicate channel IDs.
 */
export function loadWorkspaceConfig(path: string): WorkspaceConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read workspace config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in workspace config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = validateWorkspaceConfig(parsed);
  if (!result.ok) {
    const lines = result.issues.map((i) => `  - ${i.path}: ${i.message}`);
    throw new Error(`Invalid workspace config at ${path}:\n${lines.join("\n")}`);
  }
  return result.data;
}

export const WORKSPACE_CONFIG_PATH = "/workspace/config.json";

// --- Dynamic loader ---

export type ConfigLoader = () => WorkspaceConfig;

const configLog = createLogger("config-loader");

/**
 * Create a config loader that re-reads config.json on every access.
 * The file is tiny (<1KB) so there's no need for caching — changes
 * take effect immediately.
 */
export function createConfigLoader(path: string): ConfigLoader {
  let lastGood: WorkspaceConfig | null = null;

  return () => {
    try {
      lastGood = loadWorkspaceConfig(path);
      return lastGood;
    } catch (err) {
      // If we have a previous good config, keep using it
      if (lastGood) {
        logWarn(configLog, "config_reload_failed_using_last_good", {
          path,
          error: err instanceof Error ? err.message : String(err),
        });
        return lastGood;
      }
      throw new Error(
        `Failed to load workspace config from ${path} and no previous config available`,
      );
    }
  };
}

// --- Helpers ---

/**
 * Union of all channel IDs across all repos.
 */
export function getAllowedChannelIds(config: WorkspaceConfig): Set<string> {
  const ids = new Set<string>();
  for (const repo of Object.values(config.repos)) {
    for (const ch of repo.channels ?? []) {
      ids.add(ch);
    }
  }
  return ids;
}

/**
 * Map from channel ID → repo name.
 */
export function getChannelRepoMap(config: WorkspaceConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const [repo, repoConfig] of Object.entries(config.repos)) {
    for (const ch of repoConfig.channels ?? []) {
      map.set(ch, repo);
    }
  }
  return map;
}

/**
 * Interpolate ${ENV_VAR} references in a string.
 */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const envVal = process.env[name];
    if (envVal === undefined) {
      throw new Error(`Environment variable ${name} is not set`);
    }
    return envVal;
  });
}

/**
 * Interpolate all string values in a headers record.
 */
export function interpolateHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = interpolateEnv(value);
  }
  return result;
}

/**
 * Resolve a repo name to its directory on disk.
 * Returns the real path if the directory exists, `undefined` otherwise.
 * Path safety (prefix check) is enforced by the runner, not here.
 */
export function resolveRepoDirectory(repoName: string): string | undefined {
  const candidate = join(REPOS_PREFIX, repoName);
  try {
    return realpathSync(candidate);
  } catch {
    // Path does not exist on disk
    return undefined;
  }
}

/**
 * Extract repo name from a cwd path under /workspace/repos/.
 * Returns undefined if path is not under the expected prefix.
 */
export function extractRepoFromCwd(cwd: string): string | undefined {
  const normalized = normalize(resolve("/", cwd));
  if (!normalized.startsWith(REPOS_PREFIX + "/")) return undefined;
  const rest = normalized.slice(REPOS_PREFIX.length + 1);
  // Take the first path segment as the repo name
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

/**
 * Get the list of upstream names allowed for a repo.
 * Returns undefined if the repo is not in config.
 * Returns empty array if repo exists but has no proxies field.
 */
export function getRepoUpstreams(config: WorkspaceConfig, repoName: string): string[] | undefined {
  const repo = config.repos[repoName];
  if (!repo) return undefined;
  return repo.proxies ?? [];
}

/**
 * Lookup GitHub App installation ID for a configured owner.
 */
export function getInstallationIdForOwner(
  config: WorkspaceConfig,
  owner: string,
): number | undefined {
  return config.owners?.[owner]?.github_app_installation_id;
}

const ALLOWED_PREFIXES = [WORKSPACE_REPOS_ROOT];

/**
 * Check that a directory path is under an allowed workspace prefix.
 * Normalizes to prevent traversal (e.g. `/workspace/repos/../../etc`).
 * Returns true if the path is allowed, false otherwise.
 */
export function isAllowedDirectory(directory: string): boolean {
  const normalized = normalize(resolve("/", directory));
  return ALLOWED_PREFIXES.some(
    (prefix) => isPathWithin(prefix, normalized) && normalized.length > prefix.length,
  );
}
