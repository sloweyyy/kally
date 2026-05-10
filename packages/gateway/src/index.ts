import {
  createLogger,
  logError,
  logInfo,
  logWarn,
  createConfigLoader,
  createVaultClient,
  getAllowedChannelIds,
  loadGatewayEnv,
  WORKSPACE_CONFIG_PATH,
} from "@kally/common";
import { createGatewayApp } from "./app.js";
import { buildMentionLogins } from "./github.js";
import { createSlackUserResolver, nullSlackUserResolver } from "./slack-users.js";
import { createSlackWebClient } from "./enrollment.js";

const log = createLogger("gateway");

const config = loadGatewayEnv();
const githubMentionLogins = buildMentionLogins(config.githubAppSlug);
const getConfig = createConfigLoader(WORKSPACE_CONFIG_PATH);

if (!config.slackBotToken.trim()) {
  logError(log, "missing_env", "SLACK_BOT_TOKEN is required");
  process.exit(1);
}

// Slack user resolver — caches uid → email. Requires `users:read.email`
// bot scope. Without a token we degrade to uid-only (email omitted from traces).
const userResolver = config.slackBotToken
  ? createSlackUserResolver({ token: config.slackBotToken })
  : (logWarn(log, "slack_bot_token_missing", {
      note: "SLACK_BOT_TOKEN is unset — user_email will be omitted from traces",
    }),
    nullSlackUserResolver);

// Slack Web API client (views.open, conversations.open, chat.postMessage).
// Required for the `/kally connect` modal flow. No token → /slack/commands
// replies with a "not configured" message rather than crashing.
const slackWebClient = config.slackBotToken
  ? createSlackWebClient({ token: config.slackBotToken, logger: log })
  : undefined;

// Vault client — when both URL and token are set, the gateway can enroll
// credentials on behalf of a user. When unset, enrollment surfaces a
// graceful "not configured" message rather than silently dropping submissions.
const vaultClient =
  config.kallyVaultToken && config.kallyVaultUrl
    ? createVaultClient({
        baseUrl: config.kallyVaultUrl,
        token: config.kallyVaultToken,
        actor: "gateway",
        logger: log,
      })
    : (logWarn(log, "vault_not_configured", {
        note: "KALLY_VAULT_URL / KALLY_VAULT_TOKEN unset — /kally connect disabled",
      }),
      undefined);

const { app } = createGatewayApp({
  runnerUrl: config.runnerUrl,
  signingSecret: config.slackSigningSecret,
  slackBotToken: config.slackBotToken,
  slackApiBaseUrl: config.slackApiBaseUrl,
  slackBotUserId: config.slackBotUserId,
  remoteCliHost: config.remoteCliHost,
  remoteCliPort: config.remoteCliPort,
  internalSecret: config.thorInternalSecret,
  timestampToleranceSeconds: config.slackTimestampToleranceSeconds,
  queueDir: config.queueDir,
  cronSecret: config.cronSecret || undefined,
  getConfig,
  openaiAuthPath: config.openaiAuthPath || undefined,
  githubWebhookSecret: config.githubWebhookSecret,
  githubMentionLogins,
  githubAppBotId: config.githubAppBotId,
  githubAppBotEmail: config.githubAppBotEmail,
  userResolver,
  slackWebClient,
  vaultClient,
  proxyHost: config.proxyHost,
  proxyPort: config.proxyPort,
  vaultToken: config.kallyVaultToken || undefined,
});

app.listen(config.port, () => {
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
    port: config.port,
    runnerUrl: config.runnerUrl,
    slackApiBaseUrl: config.slackApiBaseUrl,
    remoteCliHost: config.remoteCliHost,
    queueDir: config.queueDir,
    configured: Boolean(config.slackSigningSecret && config.slackBotToken),
    githubAppSlug: config.githubAppSlug,
    githubAppBotId: config.githubAppBotId,
    githubMentionLogins,
    enrollmentEnabled: Boolean(vaultClient && slackWebClient),
    ...configSummary,
  });
});
