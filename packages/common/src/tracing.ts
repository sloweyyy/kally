/**
 * LangSmith tracing for Kally agent runs.
 *
 * One LangSmith "thread" per `correlationKey`, one trace per `/trigger`
 * invocation. Tool calls and LLM steps become child runs under the root trace;
 * subagent `task` tool calls become nested chain runs containing their own
 * tool/LLM children.
 *
 * Design notes:
 * - No-op when `LANGSMITH_API_KEY` is not set. Zero runtime cost, no network.
 * - Every LangSmith SDK call is wrapped in try/catch. Tracing never throws
 *   into the request path or breaks a user-facing response.
 * - Inputs and outputs are redacted (secret-like keys → `<redacted>`) and
 *   truncated so we don't ship 100KB tool outputs to LangSmith.
 *
 * Event mapping:
 *   /trigger request            → root chain run (name: "kally-session")
 *   message.part.updated (tool) → tool run (or chain run for `task`)
 *   part.sessionID != rootSid   → lives under a subagent chain, keyed by sessionID
 *   step-finish                 → llm run (tokens + cost attached as metadata)
 *   session.idle / .error       → root run ends, all open children flushed
 */

import { z } from "zod";
import { RunTree } from "langsmith";
import { Client } from "langsmith/client";
import type { Logger } from "pino";
import { logError, logInfo, logWarn, truncate } from "./logger.js";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Structured metadata attached to every trace. Gateway populates what it knows
 * (event source, user, channel); runner fills in model and directory. All
 * fields optional so callers never need to carry unknowns.
 */
export const TraceMetadataSchema = z.object({
  repo: z.string().optional(),
  agent: z.string().optional(),
  event_source: z.enum(["slack", "github", "cron", "api", "test"]).optional(),
  event_type: z.string().optional(),
  /** Stable runtime identity — Slack user id for Slack events, GH actor for GitHub. */
  user_id: z.string().optional(),
  /** Human-readable identity, typically the user's work email. */
  user_email: z.string().optional(),
  channel_id: z.string().optional(),
});

export type TraceMetadata = z.infer<typeof TraceMetadataSchema>;

export interface StartTraceInput {
  /** Root run display name. Defaults to "kally-session". */
  name?: string;
  /** User prompt (raw; will be cleaned + truncated before send). */
  prompt: string;
  /** Thread key — same value across triggers groups them as one LangSmith thread. */
  correlationKey?: string;
  /** OpenCode session ID. Stored as metadata, not as thread key. */
  opencodeSessionId: string;
  /** Session working directory (/workspace/repos/X). */
  directory: string;
  /** Model identifier (e.g. "openai/gpt-5.4"). */
  model?: string;
  /** Whether this trigger resumed an existing OpenCode session. */
  resumed?: boolean;
  /** Additional metadata from caller (event source, user id, etc.). */
  metadata?: TraceMetadata;
}

export interface RecordToolInput {
  /** Display name (e.g. "bash git status", "mcp slack post_message"). */
  name: string;
  /** Tool identifier (e.g. "bash", "task", "mcp"). */
  tool: string;
  /** Raw tool input object. */
  input: unknown;
  /** Raw tool output (string for most tools). */
  output?: unknown;
  /** Error message if the tool errored. */
  error?: string;
  /** Total duration in milliseconds. */
  durationMs?: number;
  /** Session that produced this tool call (root or a subagent child). */
  sessionId: string;
  /** Optional subagent agent name, when known (e.g. "runbook"). */
  subagent?: string;
}

export interface RecordStepInput {
  /** Step finish reason ("stop", "tool-calls", etc.). */
  reason: string;
  /** Step cost in USD. */
  cost: number;
  /** Per-step tokens. */
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  /** Model used for this step, if known. */
  model?: string;
  /** Assistant text produced in this step (for display in the LLM run). */
  text?: string;
  /** Session that produced this step (root or a subagent child). */
  sessionId: string;
}

export interface EndTraceInput {
  status: "completed" | "error";
  /** Final assistant response (joined text parts). */
  response?: string;
  /** Completed tool calls summary. */
  toolCalls?: Array<{ tool: string; state: string }>;
  totalCost?: number;
  totalTokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  error?: string;
  durationMs?: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

interface TracerConfig {
  apiKey: string;
  endpoint: string;
  project: string;
}

export interface KallyTracerOptions {
  /** Defaults to env LANGSMITH_API_KEY. */
  apiKey?: string;
  /** Defaults to env LANGSMITH_ENDPOINT or https://api.smith.langchain.com. */
  endpoint?: string;
  /** Defaults to env LANGSMITH_PROJECT or "kally". */
  project?: string;
  /** Logger used for tracer-internal errors. */
  logger?: Logger;
}

function resolveConfig(opts: KallyTracerOptions = {}): TracerConfig | null {
  const apiKey = opts.apiKey ?? process.env.LANGSMITH_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    endpoint: opts.endpoint ?? process.env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com",
    project: opts.project ?? process.env.LANGSMITH_PROJECT ?? "kally",
  };
}

// ── Redaction + truncation ────────────────────────────────────────────────────

/** Max bytes per field before truncation. */
const MAX_PROMPT_BYTES = 8_000;
const MAX_TOOL_IO_BYTES = 4_000;
const MAX_RESPONSE_BYTES = 16_000;

const SECRET_KEY_PATTERN = /(token|secret|password|authorization|cookie|api[_-]?key|bearer)/i;

/**
 * Walk a value and redact keys that look secret-bearing. Returns a new copy.
 * Strings don't get redacted by value (too lossy); we only redact by key name.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = "<redacted>";
    } else {
      out[k] = redactValue(v, depth + 1);
    }
  }
  return out;
}

/** Truncate a value after JSON-serializing, for inputs/outputs. */
function truncateForTrace(value: unknown, max: number): unknown {
  if (value == null) return value;
  if (typeof value === "string") return truncate(value, max);
  try {
    const json = JSON.stringify(value);
    if (json.length <= max) return value;
    return { _truncated: true, preview: truncate(json, max) };
  } catch {
    return { _unserializable: true };
  }
}

/** Strip the "[correlation-key: ...]" prefix the runner prepends to prompts. */
function cleanPrompt(prompt: string): string {
  return prompt.replace(/^\[correlation-key:[^\]]+\]\s*/, "");
}

// ── Trace handle ──────────────────────────────────────────────────────────────

/**
 * One in-flight trace. Returned by `tracer.startTrace()`. When tracing is
 * disabled this becomes a no-op handle — callers don't need to branch.
 */
export interface TraceHandle {
  /** True if this handle is backed by a real LangSmith trace. */
  readonly enabled: boolean;
  /** LangSmith run id, if enabled. */
  readonly runId?: string;
  /** Record a tool call completion (success or error). */
  recordTool(input: RecordToolInput): Promise<void>;
  /** Record a step boundary (LLM call metadata: tokens + cost). */
  recordStep(input: RecordStepInput): Promise<void>;
  /** Terminate the root trace and flush all open children. */
  end(input: EndTraceInput): Promise<void>;
}

class NoopTrace implements TraceHandle {
  readonly enabled = false;
  async recordTool(): Promise<void> {
    /* noop */
  }
  async recordStep(): Promise<void> {
    /* noop */
  }
  async end(): Promise<void> {
    /* noop */
  }
}

class LangSmithTrace implements TraceHandle {
  readonly enabled = true;
  readonly runId: string;

  /** Root chain run for this trigger. */
  private readonly root: RunTree;
  /** Root OpenCode session id — used to tell root tools from subagent tools. */
  private readonly rootSessionId: string;
  /** Step counter per session (root + each child). Used to name llm-step-N. */
  private readonly stepCounters = new Map<string, number>();
  /** Open subagent chain runs, keyed by child OpenCode session id. */
  private readonly subagents = new Map<string, RunTree>();
  /** When a `task` tool is pending on the root, remember its label so the child
   *  subagent run can inherit the name ("task:runbook" not "task:<session>"). */
  private pendingSubagentName?: string;
  /** Track whether end() was already called so we don't double-close. */
  private ended = false;

  constructor(
    root: RunTree,
    rootSessionId: string,
    private readonly logger?: Logger,
  ) {
    this.root = root;
    this.rootSessionId = rootSessionId;
    this.runId = root.id;
  }

  private logInternal(event: string, err: unknown): void {
    if (this.logger) {
      logWarn(this.logger, event, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Get the parent run for a given OpenCode session id. Creates the subagent
   *  chain lazily the first time a child session's event is seen. */
  private async parentFor(sessionId: string): Promise<RunTree> {
    if (sessionId === this.rootSessionId) return this.root;
    const existing = this.subagents.get(sessionId);
    if (existing) return existing;
    const name = this.pendingSubagentName
      ? `task:${this.pendingSubagentName}`
      : `task:${sessionId.slice(0, 8)}`;
    this.pendingSubagentName = undefined;
    try {
      const child = this.root.createChild({
        name,
        run_type: "chain",
        inputs: { subagent_session_id: sessionId },
      });
      await child.postRun();
      this.subagents.set(sessionId, child);
      return child;
    } catch (err) {
      this.logInternal("tracer_subagent_create_failed", err);
      return this.root;
    }
  }

  private nextStep(sessionId: string): number {
    const n = (this.stepCounters.get(sessionId) ?? 0) + 1;
    this.stepCounters.set(sessionId, n);
    return n;
  }

  async recordTool(input: RecordToolInput): Promise<void> {
    if (this.ended) return;
    // `task` tool on root → the child chain is created separately when child
    // events arrive. We still log a tool run for the parent so the task is
    // visible in the root trace, but remember the subagent name so the child
    // chain can use it.
    if (input.tool === "task" && input.sessionId === this.rootSessionId) {
      const taskInput = input.input as Record<string, unknown> | undefined;
      const agent =
        typeof taskInput?.subagent_type === "string"
          ? taskInput.subagent_type
          : typeof taskInput?.agent === "string"
            ? taskInput.agent
            : undefined;
      if (agent) this.pendingSubagentName = agent;
    }

    const parent = await this.parentFor(input.sessionId);
    const runType = input.tool === "task" ? "chain" : "tool";
    try {
      const child = parent.createChild({
        name: input.name,
        run_type: runType,
        inputs: (redactValue(truncateForTrace(input.input, MAX_TOOL_IO_BYTES)) ?? {}) as Record<
          string,
          unknown
        >,
      });
      await child.postRun();
      const outputs =
        input.output === undefined
          ? undefined
          : ({ result: truncateForTrace(input.output, MAX_TOOL_IO_BYTES) } as Record<
              string,
              unknown
            >);
      await child.end(outputs, input.error);
      await child.patchRun();
    } catch (err) {
      this.logInternal("tracer_record_tool_failed", err);
    }
  }

  async recordStep(input: RecordStepInput): Promise<void> {
    if (this.ended) return;
    const parent = await this.parentFor(input.sessionId);
    const stepNo = this.nextStep(input.sessionId);
    try {
      const child = parent.createChild({
        name: `llm-step-${stepNo}`,
        run_type: "llm",
        inputs: { step: stepNo, reason: input.reason },
        extra: {
          metadata: {
            model: input.model ?? undefined,
            tokens: input.tokens,
            cost_usd: input.cost,
          },
        },
      });
      await child.postRun();
      await child.end({
        text: input.text ? truncate(input.text, MAX_RESPONSE_BYTES) : "",
        usage: input.tokens,
        cost_usd: input.cost,
      });
      await child.patchRun();
    } catch (err) {
      this.logInternal("tracer_record_step_failed", err);
    }
  }

  async end(input: EndTraceInput): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    // Close any subagent chains that didn't get explicitly closed (shouldn't
    // happen in normal flow, but defensive — avoids dangling "running" runs).
    for (const [sid, sub] of this.subagents.entries()) {
      try {
        await sub.end(
          { note: "closed by root end()" },
          input.status === "error" ? input.error : undefined,
        );
        await sub.patchRun();
      } catch (err) {
        this.logInternal("tracer_subagent_flush_failed", err);
      }
      this.subagents.delete(sid);
    }
    try {
      const outputs: Record<string, unknown> = {};
      if (input.response !== undefined) {
        outputs.response = truncate(input.response, MAX_RESPONSE_BYTES);
      }
      if (input.toolCalls) outputs.tool_calls = input.toolCalls;
      if (input.totalCost !== undefined) outputs.cost_usd = input.totalCost;
      if (input.totalTokens) outputs.tokens = input.totalTokens;
      if (input.durationMs !== undefined) outputs.duration_ms = input.durationMs;
      await this.root.end(outputs, input.status === "error" ? input.error : undefined);
      await this.root.patchRun();
    } catch (err) {
      this.logInternal("tracer_end_failed", err);
    }
  }
}

// ── Tracer ────────────────────────────────────────────────────────────────────

/**
 * Create a tracer. Reads env vars by default; pass options to override.
 * When `LANGSMITH_API_KEY` is missing, returns a tracer whose `enabled` is
 * false and whose `startTrace` returns a no-op handle. Callers can skip the
 * branching and treat tracing as always available.
 */
export class KallyTracer {
  readonly enabled: boolean;
  readonly project: string;
  private readonly config: TracerConfig | null;
  private readonly logger?: Logger;

  constructor(opts: KallyTracerOptions = {}) {
    this.config = resolveConfig(opts);
    this.enabled = this.config !== null;
    this.project = this.config?.project ?? "kally";
    this.logger = opts.logger;
    if (this.enabled && this.logger) {
      logInfo(this.logger, "tracer_enabled", {
        project: this.project,
        endpoint: this.config!.endpoint,
      });
    }
  }

  /**
   * Open a new root trace for a trigger. Returns a handle the caller feeds
   * tool/step events into and eventually ends.
   */
  startTrace(input: StartTraceInput): TraceHandle {
    if (!this.config) return new NoopTrace();

    const metadata: Record<string, unknown> = {
      // session_id is LangSmith's thread grouping key — NOT OpenCode's session id.
      // Same correlationKey across triggers = one LangSmith thread.
      session_id: input.correlationKey,
      opencode_session_id: input.opencodeSessionId,
      directory: input.directory,
      resumed: Boolean(input.resumed),
    };
    if (input.model) metadata.model = input.model;
    if (input.metadata) {
      for (const [k, v] of Object.entries(input.metadata)) {
        if (v !== undefined) metadata[k] = v;
      }
    }

    const tags: string[] = [];
    if (input.metadata?.repo) tags.push(`repo:${input.metadata.repo}`);
    if (input.metadata?.agent) tags.push(`agent:${input.metadata.agent}`);
    if (input.metadata?.event_source) tags.push(`source:${input.metadata.event_source}`);

    try {
      const client = new Client({
        apiKey: this.config.apiKey,
        apiUrl: this.config.endpoint,
      });
      const root = new RunTree({
        name: input.name ?? "kally-session",
        run_type: "chain",
        project_name: this.config.project,
        inputs: { prompt: truncate(cleanPrompt(input.prompt), MAX_PROMPT_BYTES) },
        extra: { metadata },
        tags,
        client,
      });
      // Fire-and-forget the initial postRun — failure logged, trace continues
      // in local state and catches up on patchRun. We don't block the request
      // path on LangSmith's network.
      root.postRun().catch((err) => {
        if (this.logger) logError(this.logger, "tracer_start_post_failed", err);
      });
      return new LangSmithTrace(root, input.opencodeSessionId, this.logger);
    } catch (err) {
      if (this.logger) logError(this.logger, "tracer_start_failed", err);
      return new NoopTrace();
    }
  }
}
