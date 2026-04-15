import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KallyTracer, TraceMetadataSchema, redactValue } from "./tracing.js";

describe("TraceMetadataSchema", () => {
  it("accepts a minimal empty payload (all fields optional)", () => {
    expect(TraceMetadataSchema.parse({})).toEqual({});
  });

  it("accepts the canonical shape", () => {
    const input = {
      repo: "scratch",
      agent: "build",
      event_source: "slack" as const,
      event_type: "app_mention",
      user_id: "U0AAFTTNBQB",
      channel_id: "C0AA60K48KZ",
    };
    expect(TraceMetadataSchema.parse(input)).toEqual(input);
  });

  it("rejects unknown event_source values", () => {
    expect(() =>
      TraceMetadataSchema.parse({ event_source: "discord" as unknown as "slack" }),
    ).toThrow();
  });
});

describe("redactValue", () => {
  it("leaves primitives and simple objects alone", () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(42)).toBe(42);
    expect(redactValue("hello")).toBe("hello");
    expect(redactValue({ name: "kally", tool: "bash" })).toEqual({
      name: "kally",
      tool: "bash",
    });
  });

  it("redacts secret-shaped keys anywhere in the object", () => {
    const out = redactValue({
      command: "git push",
      headers: {
        Authorization: "Bearer abc123",
        cookie: "sess=xyz",
        "x-api-key": "sk-live-xxxxx",
      },
      password: "hunter2",
      nested: { secret_token: "shh" },
    }) as Record<string, unknown>;

    expect(out.command).toBe("git push");
    const headers = out.headers as Record<string, string>;
    expect(headers.Authorization).toBe("<redacted>");
    expect(headers.cookie).toBe("<redacted>");
    expect(headers["x-api-key"]).toBe("<redacted>");
    expect(out.password).toBe("<redacted>");
    expect((out.nested as Record<string, string>).secret_token).toBe("<redacted>");
  });

  it("is case-insensitive on secret key matching", () => {
    const out = redactValue({ TOKEN: "x", Api_Key: "y", Password: "z" }) as Record<string, string>;
    expect(out.TOKEN).toBe("<redacted>");
    expect(out.Api_Key).toBe("<redacted>");
    expect(out.Password).toBe("<redacted>");
  });

  it("handles arrays and caps depth", () => {
    const out = redactValue([{ token: "x" }, { ok: true }]) as Array<Record<string, unknown>>;
    expect(out[0].token).toBe("<redacted>");
    expect(out[1].ok).toBe(true);
  });

  it("does not throw on circular objects (depth cap)", () => {
    type Cyclic = { self?: Cyclic; field: string };
    const cyclic: Cyclic = { field: "value" };
    cyclic.self = cyclic;
    expect(() => redactValue(cyclic)).not.toThrow();
  });
});

describe("KallyTracer (no-op mode)", () => {
  const originalKey = process.env.LANGSMITH_API_KEY;

  beforeEach(() => {
    delete process.env.LANGSMITH_API_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) process.env.LANGSMITH_API_KEY = originalKey;
    else delete process.env.LANGSMITH_API_KEY;
  });

  it("is disabled when LANGSMITH_API_KEY is unset", () => {
    const tracer = new KallyTracer();
    expect(tracer.enabled).toBe(false);
  });

  it("returns a no-op handle whose methods resolve silently", async () => {
    const tracer = new KallyTracer();
    const trace = tracer.startTrace({
      prompt: "hi",
      opencodeSessionId: "ses_abc",
      directory: "/workspace/repos/scratch",
    });
    expect(trace.enabled).toBe(false);
    expect(trace.runId).toBeUndefined();
    // None of these should throw or reject.
    await expect(
      trace.recordTool({ name: "bash", tool: "bash", input: {}, sessionId: "ses_abc" }),
    ).resolves.toBeUndefined();
    await expect(
      trace.recordStep({
        reason: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        sessionId: "ses_abc",
      }),
    ).resolves.toBeUndefined();
    await expect(trace.end({ status: "completed" })).resolves.toBeUndefined();
  });
});

describe("KallyTracer (enabled mode)", () => {
  const originalKey = process.env.LANGSMITH_API_KEY;
  const originalEndpoint = process.env.LANGSMITH_ENDPOINT;
  const originalProject = process.env.LANGSMITH_PROJECT;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    process.env.LANGSMITH_API_KEY = "ls_test_key";
    process.env.LANGSMITH_ENDPOINT = "https://api.test.langsmith.invalid";
    process.env.LANGSMITH_PROJECT = "kally-test";
    fetchCalls.length = 0;
    // Stub fetch so RunTree.postRun()/patchRun() don't actually hit the network.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      fetchCalls.push({ url: String(url), init: init as RequestInit });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalKey !== undefined) process.env.LANGSMITH_API_KEY = originalKey;
    else delete process.env.LANGSMITH_API_KEY;
    if (originalEndpoint !== undefined) process.env.LANGSMITH_ENDPOINT = originalEndpoint;
    else delete process.env.LANGSMITH_ENDPOINT;
    if (originalProject !== undefined) process.env.LANGSMITH_PROJECT = originalProject;
    else delete process.env.LANGSMITH_PROJECT;
  });

  it("is enabled and exposes the configured project", () => {
    const tracer = new KallyTracer();
    expect(tracer.enabled).toBe(true);
    expect(tracer.project).toBe("kally-test");
  });

  it("startTrace returns a handle with a stable runId", () => {
    const tracer = new KallyTracer();
    const trace = tracer.startTrace({
      prompt: "hello",
      correlationKey: "slack:thread:123",
      opencodeSessionId: "ses_1",
      directory: "/workspace/repos/scratch",
      metadata: { repo: "scratch", agent: "build", event_source: "slack" },
    });
    expect(trace.enabled).toBe(true);
    expect(typeof trace.runId).toBe("string");
    expect(trace.runId!.length).toBeGreaterThan(0);
  });

  it("records tool, step, and end lifecycle without throwing", async () => {
    const tracer = new KallyTracer();
    const trace = tracer.startTrace({
      prompt: "[correlation-key: slack:thread:1] investigate SF00046518",
      correlationKey: "slack:thread:1",
      opencodeSessionId: "ses_1",
      directory: "/workspace/repos/scratch",
      model: "openai/gpt-5.4",
      resumed: false,
      metadata: { repo: "scratch", agent: "build", event_source: "slack" },
    });

    await expect(
      trace.recordTool({
        name: "mcp slack post_message",
        tool: "mcp",
        input: { channel: "C1", text: "hi", headers: { Authorization: "Bearer x" } },
        output: "posted",
        durationMs: 42,
        sessionId: "ses_1",
      }),
    ).resolves.toBeUndefined();

    await expect(
      trace.recordStep({
        reason: "stop",
        cost: 0.0012,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        model: "openai/gpt-5.4",
        text: "done",
        sessionId: "ses_1",
      }),
    ).resolves.toBeUndefined();

    await expect(
      trace.end({
        status: "completed",
        response: "all set",
        toolCalls: [{ tool: "mcp slack post_message", state: "completed" }],
        totalCost: 0.0012,
        totalTokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        durationMs: 500,
      }),
    ).resolves.toBeUndefined();
  });

  it("record* is a no-op after end() is called", async () => {
    const tracer = new KallyTracer();
    const trace = tracer.startTrace({
      prompt: "x",
      opencodeSessionId: "ses_1",
      directory: "/workspace/repos/scratch",
    });
    await trace.end({ status: "completed" });
    const callCountBefore = fetchCalls.length;
    await trace.recordTool({ name: "bash", tool: "bash", input: {}, sessionId: "ses_1" });
    await trace.recordStep({
      reason: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      sessionId: "ses_1",
    });
    // No new fetch calls after end() — post-end operations are dropped.
    expect(fetchCalls.length).toBe(callCountBefore);
  });
});
