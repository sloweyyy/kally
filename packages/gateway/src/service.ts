import {
  createLogger,
  ExecResultSchema,
  logInfo,
  logWarn,
  logError,
  truncate,
  ProgressEventSchema,
  resolveRepoDirectory,
} from "@kally/common";
import type { ProgressEvent, TraceMetadata } from "@kally/common";
import { getSlackCorrelationKey, getSlackThreadTs, type SlackThreadEvent } from "./slack.js";
import type { CronPayload } from "./cron.js";
import type { SlackUserResolver } from "./slack-users.js";
import { nullSlackUserResolver } from "./slack-users.js";

const log = createLogger("gateway-service");

// --- Runner deps (internal HTTP, testable via fetchImpl) ---

export interface RunnerDeps {
  runnerUrl: string;
  fetchImpl?: typeof fetch;
}

// --- Slack MCP deps (HTTP calls to slack-mcp service) ---

export interface SlackMcpDeps {
  slackMcpUrl: string;
  fetchImpl?: typeof fetch;
}

function getFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch;
}

/**
 * Trigger the runner and consume its NDJSON progress stream.
 * Forwards progress events to slack-mcp for Slack updates.
 */
export interface TriggerResult {
  /** True when the runner reported session busy and interrupt was false. */
  busy: boolean;
}

export async function triggerRunnerSlack(
  events: SlackThreadEvent[],
  correlationKey: string,
  deps: RunnerDeps,
  slackMcpDeps: SlackMcpDeps,
  interrupt?: boolean,
  onAccepted?: () => void,
  channelRepos?: Map<string, string>,
  onRejected?: (reason: string) => void,
  userResolver: SlackUserResolver = nullSlackUserResolver,
): Promise<TriggerResult> {
  if (events.length === 0) return { busy: false };

  const prompt =
    events.length === 1
      ? `Slack event:\n\n${JSON.stringify(events[0])}`
      : `Slack events:\n\n${JSON.stringify(events)}`;
  const last = events[events.length - 1];
  // Channel → repo lookup with a catch-all fallback.
  // Explicit mappings from config.json win; anything else routes to the
  // first configured repo (typically "scratch" or whatever comes first
  // in the map). This pairs with the commented-out channel allowlist in
  // app.ts — any channel Kally is added to gets a working default repo.
  //
  // To re-enable strict per-channel mapping, uncomment the rejection
  // below and drop the `?? firstRepo` fallback.
  const firstRepo =
    channelRepos && channelRepos.size > 0 ? channelRepos.values().next().value : undefined;
  const repo = channelRepos?.get(last.channel) ?? firstRepo;
  if (!repo) {
    logWarn(log, "channel_has_no_repo", { channel: last.channel });
    onRejected?.(`channel ${last.channel} has no repo mapping and no default repo configured`);
    return { busy: false };
  }
  if (!channelRepos?.has(last.channel)) {
    logInfo(log, "channel_using_default_repo", { channel: last.channel, repo });
  }
  // if (!repo) {
  //   logWarn(log, "channel_has_no_repo", { channel: last.channel });
  //   onRejected?.(`channel ${last.channel} has no repo mapping`);
  //   return { busy: false };
  // }
  const directory = resolveRepoDirectory(repo);
  if (!directory) {
    logWarn(log, "repo_directory_not_found", { repo, channel: last.channel });
    onRejected?.(`repo directory not found for ${repo}`);
    return { busy: false };
  }

  // Resolve Slack user → email (best-effort, cached). Degrades to uid-only
  // on missing scope, auth failure, or resolver not wired.
  const triggeringUid = "user" in last ? last.user : undefined;
  const user = triggeringUid ? await userResolver(triggeringUid) : undefined;
  const metadata: TraceMetadata = {
    repo,
    event_source: "slack",
    event_type: last.type,
    channel_id: last.channel,
    ...(triggeringUid ? { user_id: triggeringUid } : {}),
    ...(user?.email ? { user_email: user.email } : {}),
  };

  const response = await getFetch(deps.fetchImpl)(`${deps.runnerUrl}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, correlationKey, interrupt, directory, metadata }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Runner returned ${response.status}: ${text}`);
  }

  // Check for busy response (non-interrupt hit a running session)
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as Record<string, unknown>;
    if (json.busy === true) {
      return { busy: true };
    }
  }

  // Runner accepted — safe to delete queue files.
  onAccepted?.();

  // Consume NDJSON stream in the background so the queue handler can return
  // immediately. This keeps the per-key processing lock short (released as
  // soon as the runner accepts) while still forwarding progress events.
  const channel = last.channel;
  const threadTs = getSlackThreadTs(last);

  void consumeNdjsonStream(response, channel, threadTs, slackMcpDeps).catch(async (err) => {
    logError(log, "stream_consume_error", err instanceof Error ? err.message : String(err));
    await forwardProgressEvent(
      channel,
      threadTs,
      { type: "error", error: err instanceof Error ? err.message : "stream error" },
      slackMcpDeps,
    ).catch(() => {});
  });

  return { busy: false };
}

/**
 * Reads an NDJSON response body line by line and forwards events to slack-mcp.
 */
async function consumeNdjsonStream(
  response: Response,
  channel: string,
  threadTs: string,
  slackMcpDeps: SlackMcpDeps,
): Promise<void> {
  const body = response.body;
  if (!body) return;

  const lines = body.pipeThrough(new TextDecoderStream()).pipeThrough(newlineStream());
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = ProgressEventSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;

      logInfo(log, "progress_relay", {
        channel,
        threadTs,
        type: parsed.data.type,
        ...(parsed.data.type === "tool" ? { tool: parsed.data.tool } : {}),
        ...(parsed.data.type === "done" ? { status: parsed.data.status } : {}),
        ts: Date.now(),
      });

      if (parsed.data.type === "approval_required") {
        await forwardApprovalNotification(channel, threadTs, parsed.data, slackMcpDeps);
      } else {
        await forwardProgressEvent(channel, threadTs, parsed.data, slackMcpDeps);
      }
    } catch (err) {
      logWarn(log, "ndjson_parse_skip", {
        line: truncate(line, 200),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** TransformStream that splits chunks on newlines. */
function newlineStream(): TransformStream<string, string> {
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) controller.enqueue(part);
    },
    flush(controller) {
      if (buffer) controller.enqueue(buffer);
    },
  });
}

async function forwardProgressEvent(
  channel: string,
  threadTs: string,
  event: ProgressEvent,
  deps: SlackMcpDeps,
): Promise<void> {
  try {
    await getFetch(deps.fetchImpl)(`${deps.slackMcpUrl}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, threadTs, event }),
    });
  } catch (err) {
    logError(log, "progress_forward_error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Trigger the runner with a cron job payload.
 * Consumes the response stream silently — the prompt itself should
 * instruct the agent where to post results (Slack, Atlassian, etc.).
 */
export async function triggerRunnerCron(
  payload: CronPayload,
  correlationKey: string,
  deps: RunnerDeps,
  interrupt?: boolean,
  onAccepted?: () => void,
  onRejected?: (reason: string) => void,
): Promise<TriggerResult> {
  // Cron fires as a service-account identity (design doc open question 5).
  // Phase 3 enforcement treats this as its own role, not "inherited from the
  // person who wrote the crontab line."
  const metadata: TraceMetadata = {
    event_source: "cron",
    user_id: "kally-cron",
  };
  const response = await getFetch(deps.fetchImpl)(`${deps.runnerUrl}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: payload.prompt,
      correlationKey,
      interrupt,
      directory: payload.directory,
      metadata,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    // 4xx = client error (bad directory, invalid payload) — reject to dead-letter
    if (response.status >= 400 && response.status < 500) {
      onRejected?.(`Runner returned ${response.status}: ${text}`);
      return { busy: false };
    }
    throw new Error(`Runner returned ${response.status}: ${text}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as Record<string, unknown>;
    if (json.busy === true) {
      return { busy: true };
    }
  }

  onAccepted?.();

  // Consume stream silently to avoid backpressure
  const body = response.body;
  if (body) {
    for await (const _ of body) {
      // discard
    }
  }

  return { busy: false };
}

async function forwardApprovalNotification(
  channel: string,
  threadTs: string,
  event: { actionId: string; tool: string; args: Record<string, unknown>; proxyName?: string },
  deps: SlackMcpDeps,
): Promise<void> {
  try {
    await getFetch(deps.fetchImpl)(`${deps.slackMcpUrl}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel,
        threadTs,
        actionId: event.actionId,
        tool: event.tool,
        args: event.args,
        proxyName: event.proxyName,
      }),
    });
  } catch (err) {
    logError(log, "approval_forward_error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Resolve an approval action through the remote-cli MCP endpoint.
 */
export async function resolveApproval(
  actionId: string,
  decision: "approved" | "rejected",
  reviewer: string,
  remoteCliUrl: string,
  resolveSecret: string | undefined,
  fetchImpl?: typeof fetch,
  reason?: string,
): Promise<Record<string, unknown> | undefined> {
  const fetchFn = getFetch(fetchImpl);
  const args = ["resolve", actionId, decision, reviewer];
  if (reason) args.push(reason);

  try {
    const response = await fetchFn(`${remoteCliUrl}/exec/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(resolveSecret ? { "x-thor-resolve-secret": resolveSecret } : {}),
      },
      body: JSON.stringify({ args }),
    });
    const body = ExecResultSchema.parse(await response.json());
    if (!response.ok || body.exitCode !== 0) {
      logError(
        log,
        "approval_resolve_error",
        `remote-cli returned ${response.status}: ${body.stderr || body.stdout || "unknown error"}`,
        { remoteCliUrl },
      );
      return undefined;
    }
    return body as Record<string, unknown>;
  } catch (err) {
    logError(log, "approval_resolve_error", err instanceof Error ? err.message : String(err), {
      remoteCliUrl,
    });
    return undefined;
  }
}

export async function updateSlackMessage(
  channel: string,
  ts: string,
  text: string,
  deps: SlackMcpDeps,
): Promise<void> {
  try {
    await getFetch(deps.fetchImpl)(`${deps.slackMcpUrl}/update-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, ts, text }),
    });
  } catch (err) {
    logError(log, "message_update_error", err instanceof Error ? err.message : String(err));
  }
}

export async function addSlackReaction(
  channel: string,
  timestamp: string,
  reaction: string,
  deps: SlackMcpDeps,
): Promise<void> {
  try {
    await getFetch(deps.fetchImpl)(`${deps.slackMcpUrl}/reaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, timestamp, reaction }),
    });
  } catch (err) {
    logError(log, "reaction_forward_error", err instanceof Error ? err.message : String(err));
  }
}
