import express, { type Request, type Response } from "express";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { classifyTool, validatePolicy, PolicyDriftError, PolicyOverlapError } from "./policy.js";
import { connectUpstream, type UpstreamConnection } from "./upstream.js";
import { ApprovalStore } from "./approval-store.js";
import { unwrapResult } from "./unwrap-result.js";
import {
  writeToolCallLog,
  createLogger,
  logInfo,
  logWarn,
  logError,
  createConfigLoader,
  WORKSPACE_CONFIG_PATH,
  interpolateHeaders,
  extractRepoFromCwd,
  getRepoProxies,
  isAliasableMcpTool,
  computeSlackAlias,
  formatKallyMeta,
  checkUserAccess,
  createVaultClient,
  type ProxyConfig,
  type VaultClient,
} from "@kally/common";

const log = createLogger("proxy");

const PORT = parseInt(process.env.PORT || "3001", 10);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const APPROVALS_DIR = process.env.APPROVALS_DIR || "data/approvals";

const VAULT_URL = (process.env.KALLY_VAULT_URL || "http://vault:3006").replace(/\/$/, "");
const VAULT_TOKEN = process.env.KALLY_VAULT_TOKEN || "";

const getConfig = createConfigLoader(WORKSPACE_CONFIG_PATH);

// Optional vault client. When unconfigured, per_user_creds upstreams fail
// closed (412) so an operator can't forget to enable enrollment and silently
// ship container-wide creds everywhere.
let vaultClient: VaultClient | undefined;
if (VAULT_TOKEN) {
  vaultClient = createVaultClient({
    baseUrl: VAULT_URL,
    token: VAULT_TOKEN,
    actor: "proxy",
    logger: log,
  });
  logInfo(log, "vault_configured", { url: VAULT_URL });
} else {
  logWarn(log, "vault_not_configured", {
    note: "KALLY_VAULT_TOKEN unset — per-user credentials disabled, upstreams will use env-based creds",
  });
}

// --- Per-upstream instance ---

interface UserConnection {
  upstream: UpstreamConnection;
  lastUsedAt: number;
}

interface ProxyInstance {
  name: string;
  upstream: UpstreamConnection;
  approvalStore: ApprovalStore;
  /** Per-user MCP connections, keyed by Slack uid. Populated lazily by
   *  upstreams with `creds_injection: "connection"` (e.g. Atlassian). Each
   *  entry holds a separate MCP session authenticated as that user. Evicted
   *  after USER_CONNECTION_IDLE_MS of inactivity. */
  userConnections: Map<string, UserConnection>;
}

/** Evict a per-user connection after this many ms of inactivity. Keeps
 *  memory bounded while still amortizing connection setup across short
 *  bursts of tool calls from the same user. */
const USER_CONNECTION_IDLE_MS = 30 * 60 * 1000;

const instances = new Map<string, ProxyInstance>();
const connecting = new Map<string, Promise<ProxyInstance>>();

/** In-flight per-user connects. Keyed by `${upstreamName}:${uid}`. */
const userConnecting = new Map<string, Promise<UserConnection>>();

/** Get or lazily connect to an upstream by name. */
async function getInstance(name: string): Promise<ProxyInstance | undefined> {
  // Check config first — if upstream was removed, don't serve it
  const config = getConfig();
  const proxyDef = config.proxies?.[name];
  if (!proxyDef) {
    // Clean up cached instance if upstream was removed from config
    instances.delete(name);
    return undefined;
  }

  // Already connected
  const existing = instances.get(name);
  if (existing) return existing;

  // Connection in progress
  const pending = connecting.get(name);
  if (pending) return pending;

  // Connect
  const promise = connectInstance(name, proxyDef);
  connecting.set(name, promise);
  try {
    const instance = await promise;
    instances.set(name, instance);
    return instance;
  } finally {
    connecting.delete(name);
  }
}

async function connectInstance(name: string, proxyDef: ProxyConfig): Promise<ProxyInstance> {
  const interpolatedHeaders = interpolateHeaders(proxyDef.upstream.headers);
  const upstreamConfig = {
    url: proxyDef.upstream.url,
    headers: interpolatedHeaders,
  };

  const MAX_RECONNECT_ATTEMPTS = 5;
  const BASE_DELAY_MS = 1000;
  const MAX_DELAY_MS = 30_000;

  function scheduleReconnect(attempt: number) {
    const instance = instances.get(name);
    if (!instance) return;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      logError(
        log,
        "upstream_reconnect_exhausted",
        `gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`,
        { name },
      );
      instances.delete(name);
      return;
    }
    const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
    logInfo(log, "upstream_reconnecting", { name, attempt, delayMs: delay });
    setTimeout(() => {
      connectUpstream(name, upstreamConfig, () => scheduleReconnect(1))
        .then((newUpstream) => {
          instance.upstream = newUpstream;
          logInfo(log, "upstream_reconnected", { name, afterAttempt: attempt });
        })
        .catch((err) => {
          logError(
            log,
            "upstream_reconnect_failed",
            err instanceof Error ? err.message : String(err),
            {
              name,
              attempt,
            },
          );
          scheduleReconnect(attempt + 1);
        });
    }, delay);
  }

  logInfo(log, "connecting_upstream", { name, url: proxyDef.upstream.url });
  const upstream = await connectUpstream(name, upstreamConfig, () => scheduleReconnect(1));

  // Validate policy against upstream tools
  const allToolNames = upstream.tools.map((t) => t.name);
  try {
    validatePolicy(proxyDef.allow, proxyDef.approve ?? [], allToolNames);
  } catch (err) {
    if (err instanceof PolicyDriftError) {
      if (IS_PRODUCTION) {
        logWarn(log, "policy_drift", { name, orphans: err.orphans });
      } else {
        throw err;
      }
    } else if (err instanceof PolicyOverlapError) {
      throw err;
    } else {
      throw err;
    }
  }

  logInfo(log, "upstream_ready", {
    name,
    upstreamTools: allToolNames.length,
    allow: proxyDef.allow.length,
    approve: (proxyDef.approve ?? []).length,
  });

  return {
    name,
    upstream,
    // Primary: data/approvals/{upstream}/{date}/{id}.json
    // TODO: Remove legacy fallback once all in-flight approvals have drained (safe after 2026-05-01)
    approvalStore: new ApprovalStore(`${APPROVALS_DIR}/${name}`, [APPROVALS_DIR]),
    userConnections: new Map(),
  };
}

// ── Per-user upstream connections (connection-mode injection) ───────────────

/**
 * Build the Authorization header for a given provider from the user's vault
 * record. This is where we decode "what kind of header does this upstream
 * expect" per-provider, keeping the proxy agnostic to vault shapes.
 *
 * Atlassian:  `Basic base64(email:api_token)`
 *
 * Returns undefined if the creds shape doesn't match the provider we know
 * how to build headers for. Caller should surface an error to the user.
 */
function buildUpstreamAuthHeaders(
  provider: string,
  creds: Record<string, unknown>,
): Record<string, string> | undefined {
  if (provider === "atlassian") {
    const email = typeof creds.email === "string" ? creds.email : undefined;
    const token = typeof creds.api_token === "string" ? creds.api_token : undefined;
    if (!email || !token) return undefined;
    const basic = Buffer.from(`${email}:${token}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }
  return undefined;
}

/**
 * Get or create a per-user MCP connection for `connection` injection mode.
 * Each user's connection is independent: their Atlassian session identifies
 * as them, their actions appear in the audit trail as them.
 */
async function getUserInstance(
  instance: ProxyInstance,
  proxyDef: ProxyConfig,
  slack_uid: string,
  authHeaders: Record<string, string>,
): Promise<UserConnection> {
  // Touch existing entry.
  const existing = instance.userConnections.get(slack_uid);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  const key = `${instance.name}:${slack_uid}`;
  const inflight = userConnecting.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    // Merge: static upstream headers (e.g. Accept) + per-user auth. The
    // per-user auth WINS over any Authorization the config baked in.
    const staticHeaders = interpolateHeaders(proxyDef.upstream.headers) ?? {};
    const headers: Record<string, string> = { ...staticHeaders, ...authHeaders };
    logInfo(log, "user_upstream_connecting", { upstream: instance.name, slack_uid });
    const upstream = await connectUpstream(
      `${instance.name}:user:${slack_uid.slice(0, 8)}`,
      { url: proxyDef.upstream.url, headers },
      () => {
        // On disconnect, drop the entry so the next call reconnects.
        instance.userConnections.delete(slack_uid);
        logWarn(log, "user_upstream_disconnected", { upstream: instance.name, slack_uid });
      },
    );
    const entry: UserConnection = { upstream, lastUsedAt: Date.now() };
    instance.userConnections.set(slack_uid, entry);
    return entry;
  })();

  userConnecting.set(key, promise);
  try {
    return await promise;
  } finally {
    userConnecting.delete(key);
  }
}

/** Periodically evict idle per-user connections. Bounded memory cost. */
function startUserConnectionEviction(): void {
  setInterval(() => {
    const cutoff = Date.now() - USER_CONNECTION_IDLE_MS;
    for (const instance of instances.values()) {
      for (const [uid, entry] of instance.userConnections.entries()) {
        if (entry.lastUsedAt < cutoff) {
          instance.userConnections.delete(uid);
          void entry.upstream.client.close().catch(() => {});
          logInfo(log, "user_upstream_evicted", {
            upstream: instance.name,
            slack_uid: uid,
            idleMs: Date.now() - entry.lastUsedAt,
          });
        }
      }
    }
  }, 60_000).unref();
}

// --- Express app ---
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  const config = getConfig();
  const proxyNames = Object.keys(config.proxies ?? {});
  const connected = proxyNames.filter((n) => instances.has(n));
  res.json({
    status: "ok",
    service: "proxy",
    upstreams: proxyNames.length,
    connected: connected.length,
    instances: Object.fromEntries(
      proxyNames.map((n) => [
        n,
        {
          connected: instances.has(n),
          tools: instances.get(n)?.upstream.tools.length ?? 0,
        },
      ]),
    ),
  });
});

// --- Sessionless CLI endpoints ---

/** Extract Kally tracing IDs from request headers. */
function kallyIds(req: Request): { sessionId?: string; callId?: string } {
  const sessionId = req.headers["x-kally-session-id"] as string | undefined;
  const callId = req.headers["x-kally-call-id"] as string | undefined;
  return {
    ...(sessionId && { sessionId }),
    ...(callId && { callId }),
  };
}

/**
 * Extract the triggering user's identity from request headers.
 *
 * Phase 1: log-only — every tool_call log line gets {user_id, user_email}
 * so we can answer "who did what?" retroactively while we build toward the
 * Phase 3 support-only gate.
 *
 * Trust: these headers come from the OpenCode shell.env plugin, which
 * reads the per-session user.json the runner wrote. The LLM cannot forge
 * them — it never sees their values, and shell processes inherit them
 * rather than being set by agent tool calls.
 */
function kallyUser(req: Request): { user_id?: string; user_email?: string } {
  const user_id = req.headers["x-kally-user-slack-id"] as string | undefined;
  const user_email = req.headers["x-kally-user-email"] as string | undefined;
  return {
    ...(user_id && { user_id }),
    ...(user_email && { user_email }),
  };
}

/** Extract and validate repo from x-kally-directory header. */
function extractRepo(req: Request, res: Response): string | null {
  const directory = req.headers["x-kally-directory"] as string | undefined;
  if (!directory) {
    res.status(400).json({ error: "Missing required header: x-kally-directory" });
    return null;
  }
  const repo = extractRepoFromCwd(directory);
  if (!repo) {
    res.status(400).json({
      error: `Cannot determine repo from directory: ${directory}. Expected /workspace/repos/<repo>`,
    });
    return null;
  }
  return repo;
}

/** Check if a repo has access to a specific upstream. Returns true or sends 403. */
function checkRepoAccess(
  res: Response,
  config: ReturnType<typeof getConfig>,
  repo: string,
  upstreamName: string,
): boolean {
  const allowed = getRepoProxies(config, repo);
  if (allowed === undefined) {
    res.status(404).json({ error: `Repo "${repo}" not found in config` });
    return false;
  }
  if (!allowed.includes(upstreamName)) {
    res.status(403).json({
      error: `Repo "${repo}" does not have access to upstream "${upstreamName}"`,
    });
    return false;
  }
  return true;
}

// POST /user-connections/:slack_uid/invalidate — evict cached per-user MCP
// sessions for a given user. Called by the gateway right after
// /kally connect or /kally disconnect so the user's next tool call uses
// their fresh vault credentials instead of a stale cached session.
//
// Auth: requires the same KALLY_VAULT_TOKEN bearer used for vault calls.
// The proxy and vault live on the same internal network with the same
// shared secret, so callers with that token are trusted.
app.post("/user-connections/:slack_uid/invalidate", async (req, res) => {
  const bearer = req.headers.authorization;
  if (
    typeof bearer !== "string" ||
    !bearer.startsWith("Bearer ") ||
    bearer.slice(7) !== VAULT_TOKEN ||
    !VAULT_TOKEN
  ) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const uid = req.params.slack_uid;
  let evicted = 0;
  for (const instance of instances.values()) {
    const entry = instance.userConnections.get(uid);
    if (entry) {
      instance.userConnections.delete(uid);
      void entry.upstream.client.close().catch(() => {});
      evicted++;
      logInfo(log, "user_upstream_invalidated", { upstream: instance.name, slack_uid: uid });
    }
  }
  res.json({ ok: true, evicted });
});

// GET /upstreams — list upstreams available to the repo
app.get("/upstreams", (req, res) => {
  const repo = extractRepo(req, res);
  if (!repo) return;

  const config = getConfig();
  const allowed = getRepoProxies(config, repo);
  if (allowed === undefined) {
    res.status(404).json({ error: `Repo "${repo}" not found in config` });
    return;
  }

  const upstreams = allowed
    .filter((name) => config.proxies?.[name])
    .map((name) => {
      const instance = instances.get(name);
      return {
        name,
        toolCount: instance?.upstream.tools.length ?? 0,
        connected: instances.has(name),
      };
    });

  res.json({ upstreams });
});

// GET /approval/:id — search across all upstream approval stores
app.get("/approval/:id", async (req, res) => {
  try {
    const actionId = req.params.id;

    // Search across all connected instances
    for (const instance of instances.values()) {
      const action = instance.approvalStore.get(actionId);
      if (action) {
        res.json(action);
        return;
      }
    }

    // Also try connecting to all configured upstreams and checking
    const config = getConfig();
    for (const name of Object.keys(config.proxies ?? {})) {
      if (instances.has(name)) continue; // already checked
      const instance = await getInstance(name);
      if (instance) {
        const action = instance.approvalStore.get(actionId);
        if (action) {
          res.json(action);
          return;
        }
      }
    }

    res.status(404).json({ error: `No approval action found with ID: ${actionId}` });
  } catch (err) {
    logError(log, "approval_lookup_error", err, { id: req.params.id, ...kallyIds(req) });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET /approvals — list pending approvals across all upstreams
app.get("/approvals", (_req, res) => {
  const pending: Array<{ upstream: string } & Record<string, unknown>> = [];
  for (const instance of instances.values()) {
    for (const action of instance.approvalStore.listPending()) {
      pending.push({ upstream: instance.name, ...action });
    }
  }
  res.json({ approvals: pending });
});

// GET /:upstream/tools — list tools for an upstream (validates repo access)
app.get("/:upstream/tools", async (req: Request<{ upstream: string }>, res) => {
  const repo = extractRepo(req, res);
  if (!repo) return;

  const upstreamName = req.params.upstream;
  const config = getConfig();

  if (!checkRepoAccess(res, config, repo, upstreamName)) return;

  try {
    const instance = await getInstance(upstreamName);
    if (!instance) {
      res.status(404).json({ error: `Unknown upstream: ${upstreamName}` });
      return;
    }

    const proxyDef = config.proxies?.[upstreamName];
    const allow = proxyDef?.allow ?? [];
    const approve = proxyDef?.approve ?? [];

    const tools = instance.upstream.tools
      .filter((t) => classifyTool(allow, approve, t.name) !== "hidden")
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        classification: classifyTool(allow, approve, t.name),
      }));

    res.json({ tools });
  } catch (err) {
    logError(log, "tools_list_error", err, { upstream: upstreamName, ...kallyIds(req) });
    if (!res.headersSent) {
      res.status(502).json({ error: `Upstream "${upstreamName}" is unreachable` });
    }
  }
});

// POST /:upstream/tools/call — call a tool (validates repo access)
app.post("/:upstream/tools/call", async (req: Request<{ upstream: string }>, res) => {
  const repo = extractRepo(req, res);
  if (!repo) return;

  const upstreamName = req.params.upstream;
  const config = getConfig();

  if (!checkRepoAccess(res, config, repo, upstreamName)) return;

  const { name: toolName, arguments: toolArgs } = req.body as {
    name?: string;
    arguments?: Record<string, unknown>;
  };

  if (!toolName || typeof toolName !== "string") {
    res.status(400).json({ error: "Missing required field: name" });
    return;
  }

  try {
    const instance = await getInstance(upstreamName);
    if (!instance) {
      res.status(404).json({ error: `Unknown upstream: ${upstreamName}` });
      return;
    }

    const proxyDef = config.proxies?.[upstreamName];
    const allow = proxyDef?.allow ?? [];
    const approve = proxyDef?.approve ?? [];
    const args = toolArgs ?? {};
    const user = kallyUser(req);

    // --- Support-only / katalon-only access gate (runs before classification) ---
    if (proxyDef?.access && proxyDef.access !== "public") {
      const decision = checkUserAccess(config, proxyDef, user);
      if (!decision.ok) {
        logWarn(log, "access_denied", {
          upstream: upstreamName,
          tool: toolName,
          reason: decision.reason,
          ...kallyIds(req),
          ...user,
        });
        // 200 with an exitCode 1 payload so the CLI wrapper surfaces the
        // message cleanly to the agent, which can repeat it to the user.
        res.json({
          stdout: decision.message,
          stderr: `access_denied: ${decision.reason}`,
          exitCode: 1,
        });
        return;
      }
    }

    // --- Per-user credential lookup (salesforce via args; atlassian via connection) ---
    const credsMode: "args" | "connection" = proxyDef?.creds_injection ?? "args";
    let perUserAuth: Record<string, unknown> | undefined;
    let userInstanceForCall: UpstreamConnection | undefined;
    if (proxyDef?.per_user_creds) {
      if (!vaultClient) {
        logError(log, "vault_required_but_missing", "per_user_creds set but vault unconfigured", {
          upstream: upstreamName,
        });
        res.status(503).json({
          stdout: "",
          stderr: "Vault is not configured on this proxy. Contact the Kally admin.",
          exitCode: 1,
        });
        return;
      }
      if (!user.user_id) {
        res.json({
          stdout:
            "I can't tell who triggered this. Reconnect via `@Kally` in a channel " +
            "so your Slack identity flows through.",
          stderr: "unknown_user_id",
          exitCode: 1,
        });
        return;
      }
      // Vault provider name matches the upstream name by convention.
      const lookup = await vaultClient.get<Record<string, unknown>>(
        user.user_id,
        upstreamName as "salesforce" | "atlassian",
        toolName,
      );
      if (lookup.ok) {
        if (credsMode === "connection") {
          const authHeaders = buildUpstreamAuthHeaders(upstreamName, lookup.creds);
          if (!authHeaders) {
            res.status(500).json({
              stdout: "",
              stderr: `Stored credentials for ${upstreamName} are missing expected fields. Re-run \`/kally connect ${upstreamName}\`.`,
              exitCode: 1,
            });
            return;
          }
          try {
            const userInst = await getUserInstance(instance, proxyDef, user.user_id, authHeaders);
            userInstanceForCall = userInst.upstream;
          } catch (err) {
            logError(
              log,
              "user_upstream_connect_failed",
              err instanceof Error ? err.message : String(err),
              {
                upstream: upstreamName,
                user_id: user.user_id,
              },
            );
            res.status(502).json({
              stdout: "",
              stderr: `Couldn't authenticate to ${upstreamName} with your saved credentials. They may be expired — run \`/kally disconnect ${upstreamName}\` then \`/kally connect ${upstreamName}\`.`,
              exitCode: 1,
            });
            return;
          }
        } else {
          perUserAuth = lookup.creds;
        }
      } else if (lookup.status === 404) {
        logInfo(log, "per_user_creds_missing", {
          upstream: upstreamName,
          tool: toolName,
          ...user,
        });
        res.json({
          stdout:
            `I don't have your ${upstreamName} credentials yet. Run ` +
            "`/kally connect " +
            upstreamName +
            "` in Slack to enroll, then try again.",
          stderr: "creds_not_found",
          exitCode: 1,
        });
        return;
      } else {
        logError(log, "vault_unreachable", lookup.error, {
          upstream: upstreamName,
          status: lookup.status,
        });
        res.status(503).json({
          stdout: "",
          stderr: `Vault unreachable (${lookup.status}). Try again in a moment.`,
          exitCode: 1,
        });
        return;
      }
    }

    const classification = classifyTool(allow, approve, toolName);
    if (classification === "hidden") {
      res.json({ stdout: `Unknown tool: ${toolName}`, stderr: "", exitCode: 1 });
      return;
    }

    if (classification === "approve") {
      // Stamp the requester onto the action so the resolve path can look
      // up THEIR vault creds (not the reviewer's, not the container's).
      const action = instance.approvalStore.create(toolName, args, {
        uid: user.user_id,
        email: user.user_email,
      });
      logInfo(log, "tool_call_pending_approval", {
        upstream: instance.name,
        tool: toolName,
        actionId: action.id,
        ...kallyIds(req),
        ...kallyUser(req),
      });
      writeToolCallLog({ tool: toolName, decision: "pending", args });
      const approvalText = `Approval required for \`${toolName}\`. Run: approval status ${action.id}`;
      const approvalMeta = formatKallyMeta({
        type: "approval",
        actionId: action.id,
        proxyName: instance.name,
        tool: toolName,
      });
      res.json({ stdout: `${approvalText}\n${approvalMeta}`, stderr: "", exitCode: 0 });
      return;
    }

    // classification === "allow"
    // For "args" injection mode, add the reserved `_kally_auth` field so
    // the upstream MCP server (Kally-owned) can pick up per-user creds.
    // For "connection" mode, routing happens through `userInstanceForCall`
    // and args stay untouched.
    const upstreamArgs = perUserAuth ? { ...args, _kally_auth: perUserAuth } : args;
    const callClient = userInstanceForCall?.client ?? instance.upstream.client;
    const start = Date.now();
    try {
      const result = await callClient.callTool({
        name: toolName,
        arguments: upstreamArgs,
      });
      const duration = Date.now() - start;
      logInfo(log, "tool_call", {
        upstream: instance.name,
        tool: toolName,
        durationMs: duration,
        ...kallyIds(req),
        ...kallyUser(req),
      });
      writeToolCallLog({ tool: toolName, decision: "allowed", args, result, durationMs: duration });

      let stdout = unwrapResult(result);
      if (isAliasableMcpTool(toolName)) {
        const alias = computeSlackAlias(args, stdout);
        if (alias) stdout += formatKallyMeta(alias);
      }
      res.json({ stdout, stderr: "", exitCode: 0 });
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logError(log, "tool_call", message, {
        upstream: instance.name,
        tool: toolName,
        durationMs: duration,
        ...kallyIds(req),
        ...kallyUser(req),
      });
      writeToolCallLog({
        tool: toolName,
        decision: "allowed",
        args,
        durationMs: duration,
        error: message,
      });

      let stderr = `Error calling "${toolName}": ${message}\n`;
      // Append schema hint on error
      const toolInfo = instance.upstream.tools.find((t) => t.name === toolName);
      if (toolInfo?.inputSchema) {
        stderr += `\n[hint] Input schema for "${toolName}":\n${JSON.stringify(toolInfo.inputSchema, null, 2)}\n`;
      }
      res.status(502).json({ stdout: "", stderr, exitCode: 1 });
    }
  } catch (err) {
    logError(log, "tools_call_error", err, { upstream: upstreamName, ...kallyIds(req) });
    if (!res.headersSent) {
      res.status(502).json({ error: `Upstream "${upstreamName}" is unreachable` });
    }
  }
});

// --- Approval endpoints: /:upstream/approval/:id ---

app.get("/:upstream/approval/:id", async (req, res) => {
  const instance = await getInstance(req.params.upstream);
  if (!instance) {
    res.status(404).json({ error: `Unknown upstream: ${req.params.upstream}` });
    return;
  }
  const action = instance.approvalStore.get(req.params.id);
  if (!action) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(action);
});

app.post("/:upstream/approval/:id/resolve", async (req, res) => {
  const instance = await getInstance(req.params.upstream);
  if (!instance) {
    res.status(404).json({ error: `Unknown upstream: ${req.params.upstream}` });
    return;
  }

  const { decision, reviewer, reason } = req.body as {
    decision?: string;
    reviewer?: string;
    reason?: string;
  };

  if (decision !== "approved" && decision !== "rejected") {
    res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
    return;
  }

  const action = instance.approvalStore.resolve(req.params.id, decision, reviewer, reason);
  if (!action) {
    res.status(404).json({ error: "Not found or already resolved" });
    return;
  }

  if (decision === "approved") {
    // If this upstream opts into per-user creds, fetch the ORIGINAL
    // requester's vault creds (not the reviewer's) and inject them. A
    // pending action that predates Phase 3 has no requester_uid — such
    // actions fall back to container creds, same as before Phase 3.
    const config = getConfig();
    const proxyDef = config.proxies?.[instance.name];
    const approveCredsMode: "args" | "connection" = proxyDef?.creds_injection ?? "args";
    let approveArgs: Record<string, unknown> = action.args;
    let approveClient = instance.upstream.client;
    if (proxyDef?.per_user_creds && action.requester_uid && vaultClient) {
      const lookup = await vaultClient.get<Record<string, unknown>>(
        action.requester_uid,
        instance.name as "salesforce" | "atlassian",
        `approve:${action.tool}`,
      );
      if (lookup.ok) {
        if (approveCredsMode === "connection") {
          const authHeaders = buildUpstreamAuthHeaders(instance.name, lookup.creds);
          if (!authHeaders) {
            action.error = `Requester's ${instance.name} credentials are malformed. Ask <@${action.requester_uid}> to re-enroll.`;
            instance.approvalStore.update(action);
            res.json(action);
            return;
          }
          try {
            const userInst = await getUserInstance(
              instance,
              proxyDef,
              action.requester_uid,
              authHeaders,
            );
            approveClient = userInst.upstream.client;
          } catch (err) {
            logError(
              log,
              "approve_user_upstream_failed",
              err instanceof Error ? err.message : String(err),
              { upstream: instance.name, requester_uid: action.requester_uid },
            );
            action.error = `Couldn't connect to ${instance.name} as the requester. Their credentials may be expired.`;
            instance.approvalStore.update(action);
            res.json(action);
            return;
          }
        } else {
          approveArgs = { ...action.args, _kally_auth: lookup.creds };
        }
      } else if (lookup.status === 404) {
        logWarn(log, "approved_creds_missing", {
          upstream: instance.name,
          tool: action.tool,
          actionId: action.id,
          requester_uid: action.requester_uid,
        });
        action.error =
          `Requester's credentials aren't enrolled. Ask <@${action.requester_uid}> to run ` +
          `\`/kally connect ${instance.name}\` and retrigger.`;
        instance.approvalStore.update(action);
        res.json(action);
        return;
      } else {
        logError(log, "approved_creds_vault_error", lookup.error, {
          upstream: instance.name,
          actionId: action.id,
        });
        action.error = `Vault unreachable (${lookup.status}). Try again shortly.`;
        instance.approvalStore.update(action);
        res.json(action);
        return;
      }
    }

    const start = Date.now();
    try {
      const result = await approveClient.callTool({
        name: action.tool,
        arguments: approveArgs,
      });
      const duration = Date.now() - start;
      action.result = result;
      instance.approvalStore.update(action);
      logInfo(log, "tool_call_approved", {
        upstream: instance.name,
        tool: action.tool,
        actionId: action.id,
        durationMs: duration,
        requester_uid: action.requester_uid,
        requester_email: action.requester_email,
        reviewer,
      });
      writeToolCallLog({
        tool: action.tool,
        decision: "approved",
        args: action.args,
        result,
        durationMs: duration,
      });
      res.json(action);
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      action.error = message;
      instance.approvalStore.update(action);
      logError(log, "tool_call_approved_failed", message, {
        upstream: instance.name,
        tool: action.tool,
        actionId: action.id,
        durationMs: duration,
      });
      writeToolCallLog({
        tool: action.tool,
        decision: "approved",
        args: action.args,
        durationMs: duration,
        error: message,
      });
      res.json(action);
    }
  } else {
    logInfo(log, "tool_call_rejected", {
      upstream: instance.name,
      tool: action.tool,
      actionId: action.id,
      reviewer,
    });
    writeToolCallLog({ tool: action.tool, decision: "rejected", args: action.args });
    res.json(action);
  }
});

// --- Startup ---
async function start(): Promise<void> {
  // Connect to all configured upstreams eagerly at startup (if config exists)
  let proxyNames: string[] = [];
  try {
    const config = getConfig();
    proxyNames = Object.keys(config.proxies ?? {});
  } catch {
    logWarn(log, "config_not_available", { path: WORKSPACE_CONFIG_PATH });
  }

  logInfo(log, "proxy_starting", { port: PORT, upstreams: proxyNames });

  const results = await Promise.allSettled(proxyNames.map((name) => getInstance(name)));
  for (let i = 0; i < proxyNames.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      logError(log, "upstream_connect_failed", result.reason, { name: proxyNames[i] });
    }
  }

  app.listen(PORT, () => {
    logInfo(log, "proxy_listening", {
      port: PORT,
      connected: [...instances.keys()],
    });
  });
  startUserConnectionEviction();
}

process.on("SIGTERM", async () => {
  logInfo(log, "proxy_shutting_down");
  for (const instance of instances.values()) {
    // Close per-user connections first so nothing's in-flight against them.
    for (const [, entry] of instance.userConnections) {
      await entry.upstream.client.close().catch(() => {});
    }
    await instance.upstream.client.close();
  }
  process.exit(0);
});

process.on("SIGINT", async () => {
  logInfo(log, "proxy_shutting_down");
  for (const instance of instances.values()) {
    // Close per-user connections first so nothing's in-flight against them.
    for (const [, entry] of instance.userConnections) {
      await entry.upstream.client.close().catch(() => {});
    }
    await instance.upstream.client.close();
  }
  process.exit(0);
});

start().catch((err) => {
  logError(log, "proxy_start_failed", err);
  process.exit(1);
});
