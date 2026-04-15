import { describe, it, expect, vi } from "vitest";
import {
  atlassianModal,
  createSlackWebClient,
  extractInputValues,
  handleSubmission,
  openEnrollmentModal,
  parseCommandText,
  parseSlashCommand,
  pickerModal,
  providerFromCommandText,
  salesforceModal,
} from "./enrollment.js";

describe("parseSlashCommand", () => {
  it("extracts the fields we care about", () => {
    const out = parseSlashCommand({
      command: "/kally",
      text: "connect salesforce",
      user_id: "U1",
      user_name: "phuc",
      team_id: "T1",
      channel_id: "C1",
      trigger_id: "trig_123",
      response_url: "https://hooks.slack.com/resp/1",
    });
    expect(out).toMatchObject({
      command: "/kally",
      text: "connect salesforce",
      user_id: "U1",
      trigger_id: "trig_123",
    });
  });

  it("returns undefined when required fields missing", () => {
    expect(parseSlashCommand({ command: "/kally" })).toBeUndefined();
    expect(parseSlashCommand(undefined)).toBeUndefined();
    expect(parseSlashCommand("not-an-object")).toBeUndefined();
  });
});

describe("parseCommandText", () => {
  it("empty and 'help' route to help", () => {
    expect(parseCommandText("").kind).toBe("help");
    expect(parseCommandText("help").kind).toBe("help");
  });
  it("connect routes to connect with correct provider", () => {
    expect(parseCommandText("connect")).toEqual({ kind: "connect", provider: "picker" });
    expect(parseCommandText("connect salesforce")).toEqual({
      kind: "connect",
      provider: "salesforce",
    });
    expect(parseCommandText("connect atlassian")).toEqual({
      kind: "connect",
      provider: "atlassian",
    });
    expect(parseCommandText("connect snowflake")).toEqual({
      kind: "connect",
      provider: "picker",
    });
  });
  it("status routes to status", () => {
    expect(parseCommandText("status").kind).toBe("status");
  });
  it("disconnect routes correctly", () => {
    expect(parseCommandText("disconnect")).toEqual({ kind: "disconnect_picker" });
    expect(parseCommandText("disconnect salesforce")).toEqual({
      kind: "disconnect",
      provider: "salesforce",
    });
    expect(parseCommandText("disconnect atlassian")).toEqual({
      kind: "disconnect",
      provider: "atlassian",
    });
    expect(parseCommandText("disconnect snowflake")).toEqual({ kind: "disconnect_picker" });
  });
  it("unknown tokens go to unknown", () => {
    expect(parseCommandText("foo bar")).toEqual({ kind: "unknown", raw: "foo bar" });
  });
});

describe("providerFromCommandText", () => {
  it("returns picker for bare `connect`", () => {
    expect(providerFromCommandText("connect")).toBe("picker");
    expect(providerFromCommandText(" connect ")).toBe("picker");
  });
  it("returns the provider for known names", () => {
    expect(providerFromCommandText("connect salesforce")).toBe("salesforce");
    expect(providerFromCommandText("connect atlassian")).toBe("atlassian");
  });
  it("falls back to picker for unknown provider", () => {
    expect(providerFromCommandText("connect snowflake")).toBe("picker");
  });
  it("returns undefined for non-connect commands", () => {
    expect(providerFromCommandText("help")).toBeUndefined();
    expect(providerFromCommandText("")).toBeUndefined();
  });
});

describe("extractInputValues", () => {
  it("pulls plaintext values out of the Slack view state shape", () => {
    const view = {
      state: {
        values: {
          sf_username: { v: { value: "phuc@katalon.com" } },
          sf_password: { v: { value: "pw+token" } },
        },
      },
    };
    expect(extractInputValues(view)).toEqual({
      sf_username: "phuc@katalon.com",
      sf_password: "pw+token",
    });
  });
  it("returns an empty object for an empty state", () => {
    expect(extractInputValues({})).toEqual({});
    expect(extractInputValues({ state: { values: {} } })).toEqual({});
  });
});

describe("modal shapes", () => {
  it("salesforceModal carries the five required fields", () => {
    const m = salesforceModal();
    expect(m.callback_id).toBe("connect_salesforce");
    const blockIds = (m.blocks as Array<{ block_id?: string }>)
      .map((b) => b.block_id)
      .filter((x): x is string => Boolean(x));
    expect(blockIds).toEqual([
      "sf_username",
      "sf_password",
      "sf_client_id",
      "sf_client_secret",
      "sf_instance_url",
    ]);
  });

  it("atlassianModal carries the two required fields", () => {
    const m = atlassianModal();
    expect(m.callback_id).toBe("connect_atlassian");
    const blockIds = (m.blocks as Array<{ block_id?: string }>)
      .map((b) => b.block_id)
      .filter((x): x is string => Boolean(x));
    expect(blockIds).toEqual(["at_email", "at_token"]);
  });

  it("pickerModal exposes both provider buttons", () => {
    const m = pickerModal();
    expect(m.callback_id).toBe("connect_picker");
    const actions = (m.blocks as Array<{ block_id?: string; elements?: Array<{ value?: string }> }>)
      .find((b) => b.block_id === "picker")
      ?.elements?.map((e) => e.value);
    expect(actions).toEqual(["salesforce", "atlassian"]);
  });
});

describe("openEnrollmentModal", () => {
  it("opens the right modal for a provider command", async () => {
    const viewsOpen = vi.fn(async () => ({ ok: true }));
    const slack = {
      viewsOpen,
      chatPostMessageDM: vi.fn(async () => ({ ok: true })),
    };
    const cmd = {
      command: "/kally",
      text: "connect salesforce",
      user_id: "U1",
      user_name: "phuc",
      team_id: "T1",
      channel_id: "C1",
      trigger_id: "trig_1",
      response_url: "",
    };
    const out = await openEnrollmentModal(cmd, { slack });
    expect(out.ok).toBe(true);
    expect(viewsOpen).toHaveBeenCalledTimes(1);
    const [trig, view] = viewsOpen.mock.calls[0] as [string, { callback_id: string }];
    expect(trig).toBe("trig_1");
    expect(view.callback_id).toBe("connect_salesforce");
  });

  it("returns error for an unknown command text", async () => {
    const slack = {
      viewsOpen: vi.fn(async () => ({ ok: true })),
      chatPostMessageDM: vi.fn(),
    };
    const cmd = {
      command: "/kally",
      text: "disconnect everything",
      user_id: "U1",
      user_name: "",
      team_id: "T1",
      channel_id: "",
      trigger_id: "t",
      response_url: "",
    };
    const out = await openEnrollmentModal(cmd, { slack });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("unknown_command");
    expect(slack.viewsOpen).not.toHaveBeenCalled();
  });
});

describe("handleSubmission — salesforce", () => {
  const goodSfView = {
    callback_id: "connect_salesforce",
    state: {
      values: {
        sf_username: { v: { value: "phuc@katalon.com" } },
        sf_password: { v: { value: "pw+token" } },
        sf_client_id: { v: { value: "3MVG9" } },
        sf_client_secret: { v: { value: "yyy" } },
        sf_instance_url: { v: { value: "https://katalon-inc.my.salesforce.com" } },
      },
    },
  };

  it("saves when all fields are present and returns a DM", async () => {
    const put = vi.fn(async () => ({ ok: true as const }));
    const out = await handleSubmission(
      { view: goodSfView, user: { id: "U1" } },
      { vault: { put } },
    );
    expect(put).toHaveBeenCalledWith(
      "U1",
      "salesforce",
      expect.objectContaining({
        username: "phuc@katalon.com",
        password: "pw+token",
        instance_url: "https://katalon-inc.my.salesforce.com",
      }),
    );
    expect(out.response).toEqual({ response_action: "clear" });
    expect(out.dm?.text).toContain("Salesforce");
  });

  it("surfaces inline errors when a required field is missing", async () => {
    const view = {
      ...goodSfView,
      state: {
        values: {
          ...goodSfView.state!.values,
          sf_client_secret: { v: { value: "" } },
        },
      },
    };
    const put = vi.fn(async () => ({ ok: true as const }));
    const out = await handleSubmission({ view, user: { id: "U1" } }, { vault: { put } });
    expect(put).not.toHaveBeenCalled();
    expect(out.response).toMatchObject({
      response_action: "errors",
      errors: { sf_client_secret: expect.any(String) },
    });
    expect(out.dm).toBeUndefined();
  });

  it("surfaces vault errors as inline error on first field", async () => {
    const put = vi.fn(async () => ({
      ok: false as const,
      status: 400,
      error: "invalid creds: password: String must contain at least 1 character(s)",
    }));
    const out = await handleSubmission(
      { view: goodSfView, user: { id: "U1" } },
      { vault: { put } },
    );
    expect(out.response).toMatchObject({ response_action: "errors" });
    const errors = (out.response as { errors: Record<string, string> }).errors;
    expect(errors.sf_username).toContain("Vault rejected");
  });
});

describe("handleSubmission — atlassian", () => {
  it("saves email + token and returns a DM", async () => {
    const view = {
      callback_id: "connect_atlassian",
      state: {
        values: {
          at_email: { v: { value: "phuc@katalon.com" } },
          at_token: { v: { value: "ATATT3x..." } },
        },
      },
    };
    const put = vi.fn(async () => ({ ok: true as const }));
    const out = await handleSubmission({ view, user: { id: "U1" } }, { vault: { put } });
    expect(put).toHaveBeenCalledWith(
      "U1",
      "atlassian",
      expect.objectContaining({ email: "phuc@katalon.com", api_token: "ATATT3x..." }),
    );
    expect(out.response).toEqual({ response_action: "clear" });
  });
});

describe("createSlackWebClient", () => {
  it("viewsOpen posts to the correct endpoint with bearer + JSON", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const slack = createSlackWebClient({
      token: "xoxb-test",
      fetchImpl,
      apiBase: "https://fake.slack",
    });
    const out = await slack.viewsOpen("trig_1", salesforceModal());
    expect(out.ok).toBe(true);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe("https://fake.slack/views.open");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-test");
    const body = JSON.parse(init.body as string);
    expect(body.trigger_id).toBe("trig_1");
    expect(body.view.callback_id).toBe("connect_salesforce");
  });

  it("returns ok:false when Slack returns ok:false (invalid trigger_id, etc.)", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: false, error: "invalid_trigger_id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const slack = createSlackWebClient({ token: "xoxb-test", fetchImpl });
    const out = await slack.viewsOpen("bad", salesforceModal());
    expect(out.ok).toBe(false);
    expect(out.error).toBe("invalid_trigger_id");
  });

  it("chatPostMessageDM opens a DM then posts a message", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/conversations.open")) {
        return new Response(JSON.stringify({ ok: true, channel: { id: "D123" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const slack = createSlackWebClient({ token: "xoxb-test", fetchImpl });
    const out = await slack.chatPostMessageDM("U1", "hello");
    expect(out.ok).toBe(true);
    const calls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls.map((c) => c[0])).toEqual([
      "https://slack.com/api/conversations.open",
      "https://slack.com/api/chat.postMessage",
    ]);
    const postBody = JSON.parse(calls[1][1].body as string);
    expect(postBody.channel).toBe("D123");
    expect(postBody.text).toBe("hello");
  });
});
