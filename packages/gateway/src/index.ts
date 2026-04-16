import {
  createLogger,
  logInfo,
  logWarn,
  createConfigLoader,
  getAllowedChannelIds,
  WORKSPACE_CONFIG_PATH,
} from "@kally/common";
import { createGatewayApp } from "./app.js";
import { createSlackUserResolver, nullSlackUserResolver } from "./slack-users.js";
import { createSlackWebClient } from "./enrollment.js";
import { createVaultClient } from "@kally/common";

const log = createLogger("gateway");

const PORT = parseInt(process.env.PORT || "3002", 10);
const RUNNER_URL = (process.env.RUNNER_URL || "http://runner:3000").replace(/\/$/, "");
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_MCP_URL = (process.env.SLACK_MCP_URL || "http://slack-mcp:3003").replace(/\/$/, "");
const SLACK_TIMESTAMP_TOLERANCE_SECONDS = parseInt(
  process.env.SLACK_TIMESTAMP_TOLERANCE_SECONDS || "300",
  10,
);
const QUEUE_DIR = process.env.QUEUE_DIR || "data/queue";
const SLACK_BOT_USER_ID = process.env.SLACK_BOT_USER_ID || "";
const CRON_SECRET = process.env.CRON_SECRET || "";
const REMOTE_CLI_HOST = process.env.REMOTE_CLI_HOST || "remote-cli";
const REMOTE_CLI_PORT = parseInt(process.env.REMOTE_CLI_PORT || "3004", 10);
const RESOLVE_SECRET = process.env.RESOLVE_SECRET || "";
const OPENAI_AUTH_PATH = process.env.OPENAI_AUTH_PATH || "";
const PROXY_HOST = process.env.PROXY_HOST || "proxy";
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "3001", 10);
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const VAULT_URL = (process.env.KALLY_VAULT_URL || "http://vault:3006").replace(/\/$/, "");
const VAULT_TOKEN = process.env.KALLY_VAULT_TOKEN || "";
const getConfig = createConfigLoader(WORKSPACE_CONFIG_PATH);

// Slack user resolver — caches uid → email. Requires `users:read.email` bot
// scope. Without a token we degrade to uid-only (email omitted from traces).
const userResolver = SLACK_BOT_TOKEN
  ? createSlackUserResolver({ token: SLACK_BOT_TOKEN })
  : (logWarn(log, "slack_bot_token_missing", {
      note: "SLACK_BOT_TOKEN is unset — user_email will be omitted from traces",
    }),
    nullSlackUserResolver);

// Slack Web API client (views.open, conversations.open, chat.postMessage).
// Required for the `/kally connect` modal flow. No token → /slack/commands
// replies with a "not configured" message rather than crashing.
const slackWebClient = SLACK_BOT_TOKEN
  ? createSlackWebClient({ token: SLACK_BOT_TOKEN, logger: log })
  : undefined;

// Vault client — when both URL and token are set, the gateway can enroll
// credentials on behalf of a user. When unset, enrollment surfaces a
// graceful error in Slack rather than silently dropping submissions.
const vaultClient =
  VAULT_TOKEN && VAULT_URL
    ? createVaultClient({
        baseUrl: VAULT_URL,
        token: VAULT_TOKEN,
        actor: "gateway",
        logger: log,
      })
    : (logWarn(log, "vault_not_configured", {
        note: "KALLY_VAULT_URL / KALLY_VAULT_TOKEN unset — /kally connect disabled",
      }),
      undefined);

const { app } = createGatewayApp({
  runnerUrl: RUNNER_URL,
  signingSecret: SLACK_SIGNING_SECRET,
  slackMcpUrl: SLACK_MCP_URL,
  slackBotUserId: SLACK_BOT_USER_ID,
  remoteCliHost: REMOTE_CLI_HOST,
  remoteCliPort: REMOTE_CLI_PORT,
  resolveSecret: RESOLVE_SECRET,
  timestampToleranceSeconds: SLACK_TIMESTAMP_TOLERANCE_SECONDS,
  queueDir: QUEUE_DIR,
  cronSecret: CRON_SECRET || undefined,
  getConfig,
  openaiAuthPath: OPENAI_AUTH_PATH || undefined,
  userResolver,
  slackWebClient,
  vaultClient,
  proxyHost: PROXY_HOST,
  proxyPort: PROXY_PORT,
});

app.listen(PORT, () => {
  let configSummary: Record<string, unknown> = {};
  try {
    const config = getConfig();
    configSummary = {
      allowedChannels: [...getAllowedChannelIds(config)],
      repos: Object.keys(config.repos),
    };
  } catch {
    configSummary = { config: "not available yet" };
  }
  logInfo(log, "gateway_started", {
    port: PORT,
    runnerUrl: RUNNER_URL,
    slackMcpUrl: SLACK_MCP_URL,
    remoteCliHost: REMOTE_CLI_HOST,
    queueDir: QUEUE_DIR,
    configured: Boolean(SLACK_SIGNING_SECRET),
    ...configSummary,
  });
});
