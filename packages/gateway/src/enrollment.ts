/**
 * Slack-modal-based credential enrollment.
 *
 * Flow:
 *  1. User types `/kally connect <provider>` in Slack.
 *  2. Slack POSTs to /slack/commands → gateway calls `views.open` with
 *     the corresponding modal and replies to the command within 3 seconds.
 *  3. User fills the modal and submits.
 *  4. Slack POSTs the `view_submission` to /slack/interactivity → gateway
 *     validates, PUTs into vault, DMs the user on success.
 *
 * Limitations worth flagging in the modal UI:
 *  - Slack's `plain_text_input` element has no password-masking option.
 *    The warning banner tells users not to screen-share while enrolling.
 *  - Typed values are attached to the view's `state.values` and stored on
 *    Slack's side for a few minutes. Not logged in channel history, but
 *    transmitted over TLS and visible server-side to Slack. For strict
 *    regimes, Phase 4 offers a web-form alternative.
 */

import type { Logger } from "@kally/common";
import { logError, logInfo } from "@kally/common";

// ── Slash-command parsing ────────────────────────────────────────────────────

export interface SlashCommand {
  command: string; // "/kally"
  text: string; // "connect salesforce"
  user_id: string;
  user_name: string;
  team_id: string;
  channel_id: string;
  trigger_id: string;
  response_url: string;
}

/**
 * Slack slash commands arrive as form-urlencoded. This extracts just the
 * fields we care about. Any field missing returns undefined so we can
 * short-circuit rather than building a 20-field schema for a 7-field need.
 */
export function parseSlashCommand(body: unknown): SlashCommand | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const required = ["command", "text", "user_id", "trigger_id", "team_id"];
  for (const k of required) if (typeof b[k] !== "string") return undefined;
  return {
    command: b.command as string,
    text: (b.text as string | undefined) ?? "",
    user_id: b.user_id as string,
    user_name: (b.user_name as string | undefined) ?? "",
    team_id: b.team_id as string,
    channel_id: (b.channel_id as string | undefined) ?? "",
    trigger_id: b.trigger_id as string,
    response_url: (b.response_url as string | undefined) ?? "",
  };
}

// ── Modal views ──────────────────────────────────────────────────────────────

export type EnrollProvider = "salesforce" | "atlassian";

const SALESFORCE_DEFAULT_INSTANCE = "https://katalon-inc.my.salesforce.com";

interface SlackView {
  type: "modal";
  callback_id: string;
  title: { type: "plain_text"; text: string };
  submit: { type: "plain_text"; text: string };
  close: { type: "plain_text"; text: string };
  blocks: unknown[];
}

function privacyBanner(): unknown {
  return {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text:
          "🔒 These credentials are encrypted with AES-256-GCM before storage. " +
          "We never log plaintext. Don't screen-share while typing — Slack's modal " +
          "fields aren't password-masked.",
      },
    ],
  };
}

function textInput(
  blockId: string,
  actionId: string,
  label: string,
  hint?: string,
  placeholder?: string,
  initial?: string,
): unknown {
  return {
    type: "input",
    block_id: blockId,
    label: { type: "plain_text", text: label },
    ...(hint ? { hint: { type: "plain_text", text: hint } } : {}),
    element: {
      type: "plain_text_input",
      action_id: actionId,
      ...(placeholder ? { placeholder: { type: "plain_text", text: placeholder } } : {}),
      ...(initial ? { initial_value: initial } : {}),
    },
  };
}

export function salesforceModal(): SlackView {
  return {
    type: "modal",
    callback_id: "connect_salesforce",
    title: { type: "plain_text", text: "Connect Salesforce" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      privacyBanner(),
      textInput(
        "sf_username",
        "v",
        "Salesforce username",
        "Your Salesforce login email.",
        "you@katalon.com",
      ),
      textInput(
        "sf_password",
        "v",
        "Password + security token",
        "Concatenate your SF password and 25-char security token, no separator.",
      ),
      textInput("sf_client_id", "v", "Consumer key (client ID)"),
      textInput("sf_client_secret", "v", "Consumer secret"),
      textInput(
        "sf_instance_url",
        "v",
        "Instance URL",
        "Usually https://katalon-inc.my.salesforce.com.",
        "https://katalon-inc.my.salesforce.com",
        SALESFORCE_DEFAULT_INSTANCE,
      ),
    ],
  };
}

export function atlassianModal(): SlackView {
  return {
    type: "modal",
    callback_id: "connect_atlassian",
    title: { type: "plain_text", text: "Connect Atlassian" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      privacyBanner(),
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*You need a Rovo MCP API token.*\n" +
            "A plain (unscoped) API token exposes only 2 tools; a Rovo MCP token " +
            "exposes the full Jira / Confluence / Bitbucket surface Kally needs " +
            "(45+ tools).\n\n" +
            "*How to generate one:*\n" +
            "1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens|id.atlassian.com/manage-profile/security/api-tokens>\n" +
            "2. Click *Create API token with scopes*\n" +
            "3. On the *Select the app* step, pick *Rovo MCP* (one app per token is fine — Rovo MCP covers Jira, Confluence, and Bitbucket through the MCP endpoint)\n" +
            "4. Grant all the scopes it offers, copy the token here.",
        },
      },
      textInput("at_email", "v", "Atlassian account email", undefined, "you@katalon.com"),
      textInput(
        "at_token",
        "v",
        "Scoped Rovo MCP token",
        "Starts with ATATT3x... — the scoped one, not the plain API token.",
      ),
    ],
  };
}

export function pickerModal(): SlackView {
  return {
    type: "modal",
    callback_id: "connect_picker",
    title: { type: "plain_text", text: "Connect Kally" },
    submit: { type: "plain_text", text: "Continue" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Which service do you want Kally to act on your behalf for?",
        },
      },
      {
        type: "actions",
        block_id: "picker",
        elements: [
          {
            type: "button",
            action_id: "connect_pick_salesforce",
            text: { type: "plain_text", text: "Salesforce" },
            style: "primary",
            value: "salesforce",
          },
          {
            type: "button",
            action_id: "connect_pick_atlassian",
            text: { type: "plain_text", text: "Atlassian" },
            value: "atlassian",
          },
        ],
      },
      privacyBanner(),
    ],
  };
}

/** Parse `text` from a slash command to extract a provider name. */
export function providerFromCommandText(text: string): EnrollProvider | "picker" | undefined {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  // Expected forms:
  //   /kally connect             → picker
  //   /kally connect salesforce  → salesforce
  //   /kally connect atlassian   → atlassian
  if (parts[0] !== "connect") return undefined;
  if (parts.length === 1) return "picker";
  const p = parts[1];
  if (p === "salesforce" || p === "atlassian") return p;
  return "picker";
}

/** Shape of a sub-command parsed from the full `/kally ...` text. Added so
 *  the gateway can route to the right handler (connect/status/disconnect)
 *  without scattering string parsing across call sites. */
export type ParsedCommand =
  | { kind: "help" }
  | { kind: "connect"; provider: EnrollProvider | "picker" }
  | { kind: "status" }
  | { kind: "disconnect"; provider: EnrollProvider }
  | { kind: "disconnect_picker" }
  | { kind: "unknown"; raw: string };

/** Full parser for the `/kally ...` slash-command text. */
export function parseCommandText(text: string): ParsedCommand {
  const t = text.trim();
  if (t === "" || t === "help") return { kind: "help" };
  const parts = t.split(/\s+/);
  if (parts[0] === "connect") {
    if (parts.length === 1) return { kind: "connect", provider: "picker" };
    const p = parts[1];
    if (p === "salesforce" || p === "atlassian") return { kind: "connect", provider: p };
    return { kind: "connect", provider: "picker" };
  }
  if (parts[0] === "status") return { kind: "status" };
  if (parts[0] === "disconnect") {
    if (parts.length === 1) return { kind: "disconnect_picker" };
    const p = parts[1];
    if (p === "salesforce" || p === "atlassian") return { kind: "disconnect", provider: p };
    return { kind: "disconnect_picker" };
  }
  return { kind: "unknown", raw: t };
}

// ── View-submission payload extraction ──────────────────────────────────────

/**
 * Pull the typed plaintext values out of a Slack view_submission payload.
 * We use `action_id = "v"` on every input so the structure is predictable
 * and tests are easy to write.
 */
export function extractInputValues(view: unknown): Record<string, string> {
  const v = view as { state?: { values?: Record<string, Record<string, { value?: string }>> } };
  const out: Record<string, string> = {};
  const values = v?.state?.values ?? {};
  for (const [blockId, actions] of Object.entries(values)) {
    for (const [, action] of Object.entries(actions)) {
      if (typeof action.value === "string") out[blockId] = action.value;
    }
  }
  return out;
}

// ── Slack Web API helpers (only the two calls we need) ──────────────────────

export interface SlackWebClient {
  viewsOpen(trigger_id: string, view: SlackView): Promise<{ ok: boolean; error?: string }>;
  viewsUpdate(
    view_id: string,
    view: SlackView,
    hash?: string,
  ): Promise<{ ok: boolean; error?: string }>;
  chatPostMessageDM(
    slack_uid: string,
    text: string,
    blocks?: unknown[],
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface CreateSlackWebClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  logger?: Logger;
}

export function createSlackWebClient(opts: CreateSlackWebClientOptions): SlackWebClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? "https://slack.com/api";
  const token = opts.token;

  async function post<T>(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string; body?: T }> {
    if (!token) return { ok: false, error: "missing_slack_token" };
    try {
      const res = await fetchImpl(`${apiBase}/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok && opts.logger) {
        logError(opts.logger, `slack_${path}_error`, body.error ?? "unknown", payload);
      }
      return { ok: body.ok, error: body.error, body: body as unknown as T };
    } catch (err) {
      if (opts.logger)
        logError(
          opts.logger,
          `slack_${path}_fetch_error`,
          err instanceof Error ? err.message : String(err),
        );
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    viewsOpen(trigger_id, view) {
      return post("views.open", { trigger_id, view });
    },
    viewsUpdate(view_id, view, hash) {
      return post("views.update", { view_id, view, ...(hash && { hash }) });
    },
    async chatPostMessageDM(slack_uid, text, blocks) {
      // conversations.open with a user id returns a DM channel we can post into.
      const open = await post<{ channel?: { id: string } }>("conversations.open", {
        users: slack_uid,
      });
      if (!open.ok || !open.body?.channel?.id) {
        return { ok: false, error: open.error ?? "conversations_open_failed" };
      }
      const channel = open.body.channel.id;
      return post("chat.postMessage", { channel, text, ...(blocks ? { blocks } : {}) });
    },
  };
}

// ── High-level helpers consumed by the gateway app ───────────────────────────

export interface OpenEnrollModalDeps {
  slack: SlackWebClient;
  logger?: Logger;
}

export async function openEnrollmentModal(
  cmd: SlashCommand,
  deps: OpenEnrollModalDeps,
): Promise<{ ok: boolean; error?: string }> {
  const pick = providerFromCommandText(cmd.text);
  if (!pick) {
    if (deps.logger) logInfo(deps.logger, "unknown_slash_text", { text: cmd.text });
    return { ok: false, error: "unknown_command" };
  }
  const view =
    pick === "salesforce"
      ? salesforceModal()
      : pick === "atlassian"
        ? atlassianModal()
        : pickerModal();
  return deps.slack.viewsOpen(cmd.trigger_id, view);
}

export interface SubmissionResolution {
  /** `response_action` to send back to Slack (closes or updates the modal). */
  response: Record<string, unknown>;
  /** What to DM the user after responding, if anything. */
  dm?: { text: string };
}

/**
 * Consume a view_submission payload and run the save side-effects. Returns
 * what the HTTP handler should send back to Slack plus an optional DM.
 *
 * Validation errors land as inline field errors in the modal. Vault errors
 * show up as a banner (modal update). Both keep the user on the screen so
 * they can fix and retry.
 */
export async function handleSubmission(
  payload: {
    view: {
      callback_id: string;
      state?: { values?: Record<string, Record<string, { value?: string }>> };
    };
    user: { id: string };
  },
  deps: {
    vault: {
      put(
        slack_uid: string,
        provider: EnrollProvider,
        creds: Record<string, unknown>,
      ): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
    };
    logger?: Logger;
  },
): Promise<SubmissionResolution> {
  const uid = payload.user.id;
  const callback = payload.view.callback_id;
  const vals = extractInputValues(payload.view);

  if (callback === "connect_salesforce") {
    // Map form block_ids → vault field names.
    const creds = {
      username: vals.sf_username,
      password: vals.sf_password,
      client_id: vals.sf_client_id,
      client_secret: vals.sf_client_secret,
      instance_url: vals.sf_instance_url,
    };
    const missing = Object.entries(creds)
      .filter(([, v]) => !v || typeof v !== "string" || v.trim() === "")
      .map(([k]) => k);
    if (missing.length > 0) {
      return {
        response: {
          response_action: "errors",
          errors: Object.fromEntries(
            missing.map((name) => [`sf_${name}`, "This field is required"]),
          ),
        },
      };
    }
    const result = await deps.vault.put(uid, "salesforce", creds);
    if (!result.ok) {
      if (deps.logger)
        logError(deps.logger, "enroll_put_failed", result.error, {
          uid,
          provider: "salesforce",
          status: result.status,
        });
      return {
        response: {
          response_action: "errors",
          errors: {
            sf_username: "Vault rejected: " + result.error.slice(0, 120),
          },
        },
      };
    }
    return {
      response: { response_action: "clear" },
      dm: {
        text: "✅ Salesforce credentials saved. Mention `@Kally` in your support channel to try a tool that needs them.",
      },
    };
  }

  if (callback === "connect_atlassian") {
    const creds = { email: vals.at_email, api_token: vals.at_token };
    const missing = Object.entries(creds)
      .filter(([, v]) => !v || typeof v !== "string" || v.trim() === "")
      .map(([k]) => k);
    if (missing.length > 0) {
      return {
        response: {
          response_action: "errors",
          errors: Object.fromEntries(
            missing.map((name) => [`at_${name}`, "This field is required"]),
          ),
        },
      };
    }
    const result = await deps.vault.put(uid, "atlassian", creds);
    if (!result.ok) {
      return {
        response: {
          response_action: "errors",
          errors: { at_email: "Vault rejected: " + result.error.slice(0, 120) },
        },
      };
    }
    return {
      response: { response_action: "clear" },
      dm: {
        text: "✅ Atlassian credentials saved. Mention `@Kally` in your support channel to try a Jira or Confluence lookup.",
      },
    };
  }

  if (deps.logger) logInfo(deps.logger, "unknown_callback_id", { callback });
  return { response: {} };
}
