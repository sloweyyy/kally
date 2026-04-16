export {
  WorkspaceConfigSchema,
  loadWorkspaceConfig,
  getAllowedChannelIds,
  getChannelRepoMap,
  resolveRepoDirectory,
  isAllowedDirectory,
  createConfigLoader,
  WORKSPACE_CONFIG_PATH,
  getProxyConfig,
  extractRepoFromCwd,
  getRepoUpstreams,
  interpolateEnv,
  interpolateHeaders,
  checkUserAccess,
} from "./workspace-config.js";
export type {
  WorkspaceConfig,
  RepoConfig,
  ProxyConfig,
  ProxyUpstream,
  ConfigLoader,
  GitHubAppInstallation,
  GitHubAppConfig,
  AccessPolicy,
  AccessUser,
  AccessDecision,
} from "./workspace-config.js";
export { createVaultClient, invalidateProxyUserConnections } from "./vault-client.js";
export type {
  VaultClient,
  VaultClientConfig,
  VaultProvider,
  VaultGetResponse,
  VaultGetResult,
  VaultErr,
} from "./vault-client.js";
export { writeToolCallLog } from "./worklog.js";
export type { ToolCallLogEntry } from "./worklog.js";
export { createLogger, logInfo, logWarn, logError, truncate } from "./logger.js";
export type { Logger } from "./logger.js";
export {
  readNotes,
  createNotes,
  continueNotes,
  appendTrigger,
  appendSummary,
  findNotesFile,
  getSessionIdFromNotes,
  registerAlias,
  resolveCorrelationKeys,
  isAliasableTool,
  isAliasableGitCommand,
  isAliasableMcpTool,
  extractAliases,
  getNotesLineCount,
  hasSlackReply,
  KallyMetaSchema,
  KallyMetaAliasSchema,
  KallyMetaApprovalSchema,
  extractKallyMeta,
  formatKallyMeta,
  computeGitAlias,
  computeSlackAlias,
  inferRepoFromPath,
  extractBranchFromGitArgs,
} from "./notes.js";
export type {
  ToolArtifact,
  ExtractedAlias,
  KallyMeta,
  KallyMetaAlias,
  KallyMetaApproval,
} from "./notes.js";
export { ExecResultSchema, NdjsonChunkSchema } from "./exec-result.js";
export type { ExecResult, NdjsonChunk } from "./exec-result.js";
export { KallyTracer, TraceMetadataSchema, redactValue } from "./tracing.js";
export type {
  TraceMetadata,
  TraceHandle,
  StartTraceInput,
  RecordToolInput,
  RecordStepInput,
  EndTraceInput,
  KallyTracerOptions,
} from "./tracing.js";
export {
  ProgressStartSchema,
  ProgressToolSchema,
  ProgressDoneSchema,
  ProgressErrorSchema,
  ProgressApprovalRequiredSchema,
  ProgressEventSchema,
  SlackProgressRequestSchema,
  SlackReactionRequestSchema,
  SlackApprovalRequestSchema,
} from "./progress-events.js";
export type {
  ProgressStart,
  ProgressTool,
  ProgressDone,
  ProgressError,
  ProgressApprovalRequired,
  ProgressEvent,
  SlackProgressRequest,
  SlackReactionRequest,
  SlackApprovalRequest,
} from "./progress-events.js";
