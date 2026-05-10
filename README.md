# Kally

An ambient AI support teammate that lives in Slack, acts on Salesforce / Jira / Confluence on behalf of the person who mentioned it, and keeps every action attributable, auditable, and revocable.

Built for Katalon's Product Support team. Each teammate brings their own credentials through a Slack slash-command modal; the proxy enforces who may call what; every write goes through a human approval prompt; every credential stays encrypted at rest.

## What it does

Mention `@Kally` in Slack, or run one of the slash subcommands:

- **`@Kally triage my open cases`** — runbook across your SF queue, prioritized next-actions
- **`@Kally create a KSR for SF00046518`** — escalate a case to DEV as a Jira KSR, with the template-faithful ADF body and the mandatory SF link + status update afterwards
- **`@Kally analyze the log on SF00046155`** — scan attachments (PDF, ZIP, log bundles up to 50MB) for known error signatures and matching live KSRs
- **`@Kally write a KB from SF00045276`** — turn a resolved case into a Confluence article; checks existing coverage first
- Plus general-purpose: SOQL queries, Jira search, case comments, status changes, anything else an OpenCode-driven MCP agent can do

Writes go through an Approve / Reject prompt in the channel. On approval, the call authenticates as the person who asked for it — not a shared service account.

## How users connect

A one-time three-minute flow per teammate, entirely inside Slack:

```
/kally connect salesforce      → modal → paste SF creds
/kally connect atlassian       → modal → paste a Rovo MCP API token
/kally status                  → show your enrolled services + last update
/kally disconnect <service>    → revoke a specific credential
/kally help                    → list commands
```

Credentials are encrypted with AES-256-GCM before they hit disk. The plaintext exists only for the single subprocess call it authorizes. The vault's audit log records every read (who, when, for what tool). Revoking is one slash-command away and invalidates cached sessions immediately.

Access rules are configured per upstream (`docker-volumes/workspace/config.json`):

- **public** — any Slack user in an allowed channel
- **katalon** — email must end with a configured suffix (default `@katalon.com`)
- **support** — email must be in the explicit `support_team_emails` allowlist

Salesforce ships support-only. Atlassian ships katalon-wide. Slack is public. Non-matching users see a friendly "ping @admin" message and the upstream is never called.

## Architecture

```
                  ┌─────────┐
                  │ ingress │
                  │ (nginx) │
                  └────┬────┘
             ┌─────────┴────────┐
             ▼                  ▼
      ┌────────────┐      ┌───────────┐
      │  gateway   │      │  opencode │
      │ webhooks + │      │ AI engine │
      │ /kally cmd │      └──┬──────┬─┘
      └─────┬──────┘      MCP│      │bash/git/gh
            │                ▼      ▼
            ▼         ┌──────────┐ ┌─────────────┐
      ┌──────────┐    │  proxy   │ │  remote-cli │
      │  runner  │    │  gate +  │ │ git/gh/scoutqa
      │ sessions │    │ per-user │ │  langfuse   │
      └──────────┘    │   creds  │ │             │
                      └────┬─────┘ └─────────────┘
                           │        vault lookup
                    ┌──────┼──────────┐
                    ▼      ▼          ▼
             Atlassian Salesforce Slack        ┌─────────┐
             (hosted)   MCP        MCP      ◄──┤  vault  │
                        (Kally)   (Kally)      │ creds + │
                                               │  audit  │
                                               └─────────┘
```

**Gateway** ingests Slack events and slash commands, resolves Slack uid → email via `users.info`, and attaches identity metadata to every runner trigger. **Runner** opens or resumes an OpenCode session and streams NDJSON progress back to Slack. **Proxy** is the trust boundary: it checks the access policy, looks up the caller's vault credentials, and either splices them into the tool args (Salesforce subprocess) or opens a per-user MCP session (Atlassian). **Vault** holds encrypted per-user credentials and never ships plaintext anywhere it isn't explicitly consumed. **Opencode** only ever sees sanitized tool results; credentials never enter the agent's context window.

## Services

| Service            | Port            | Package                 | Role                                                                                                                                   |
| ------------------ | --------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **gateway**        | 3002            | `@kally/gateway`        | Slack events + slash commands, `/kally connect` modal, signature verification, event batching                                          |
| **runner**         | 3000            | `@kally/runner`         | OpenCode session lifecycle, NDJSON progress stream, LangSmith trace emission                                                           |
| **opencode**       | 4096            | opencode-ai@1.4.3       | Headless AI agent runtime (subagents: runbook, create-ksr, knowledge-consolidation, analyze-log)                                       |
| **proxy**          | 3001            | `@kally/proxy`          | Access gate, vault lookup, per-user MCP connection cache, approval queue                                                               |
| **vault**          | 3006 (internal) | `@kally/vault`          | AES-256-GCM encrypted credential store + append-only audit log                                                                         |
| **slack-mcp**      | 3003            | `@kally/slack-mcp`      | Slack API MCP server with multimodal file handling (PDF, ZIP, images up to 50MB) + Block Kit progress                                  |
| **salesforce-mcp** | 3005            | `@kally/salesforce-mcp` | Salesforce MCP server wrapping `sf_ops.py` (10 tools: fetch, query, bulk, comment, status, Jira link, ETA, attachments, internal note) |
| **remote-cli**     | 3004            | `@kally/remote-cli`     | Sandboxed shell for git / gh / scoutqa / langfuse / metabase CLIs                                                                      |
| **data**           | 3080            | `docker/data`           | Nginx credential-injecting proxy for ad-hoc internal APIs                                                                              |
| **cron**           | —               | `docker/cron`           | BusyBox crond for scheduled `hey-kally` prompts                                                                                        |
| **ingress**        | 8080            | `docker/ingress`        | Nginx + Vouch SSO in front of OpenCode's web UI                                                                                        |
| **vouch**          | 9090 (internal) | vouch-proxy             | Google OAuth for ingress auth                                                                                                          |

Atlassian MCP is a hosted service at `mcp.atlassian.com/v1/mcp`, proxied per-user.

## Quick start

### Prerequisites

- Docker Desktop (or equivalent)
- Slack workspace you admin
- A Salesforce Connected App (for the support team)

### Bring the stack up

```bash
cp .env.example .env
# Fill in everything in .env (see sections below)

docker compose up --build -d
docker compose ps                     # 12 services, all healthy
curl http://localhost:8080/health     # 200 OK
```

### `.env` essentials

| Variable                 | Purpose                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`   | Verify inbound Slack webhook signatures                                                                                               |
| `SLACK_BOT_TOKEN`        | Bot token (`xoxb-...`) for Web API calls (`users.info`, `views.open`, `chat.postMessage`)                                             |
| `SLACK_BOT_USER_ID`      | Bot's own uid, used to ignore its own messages                                                                                        |
| `CRON_SECRET`            | Shared secret for the cron → gateway trigger endpoint                                                                                 |
| `KALLY_VAULT_MASTER_KEY` | 32-byte base64 AES key. **Back this up out of band.** Losing it bricks every enrolled credential. Generate: `openssl rand -base64 32` |
| `KALLY_VAULT_TOKEN`      | Bearer token shared between gateway/proxy and vault. Generate: `openssl rand -hex 32`                                                 |
| `LANGSMITH_API_KEY`      | Optional. When set, runner emits structured traces. Omit for no-op.                                                                   |
| `LANGSMITH_PROJECT`      | Defaults to `kally`                                                                                                                   |
| `SALESFORCE_*`           | Service-account creds; Phase 3 vestigial unless a cron/service path needs them                                                        |
| `ATLASSIAN_BASIC_AUTH`   | Bootstrap creds used only to enumerate the hosted MCP's tool list at proxy startup                                                    |
| `GITHUB_PAT`             | Fine-grained PAT for git operations via `remote-cli`                                                                                  |
| `VOUCH_*`                | Google OAuth for the OpenCode web UI                                                                                                  |

Full list with generation commands lives in `.env.example`.

### Slack app setup

1. **Slash command** — create `/kally` → request URL `https://<your-domain>/slack/commands`. Usage hint: `connect salesforce | status | help`.
2. **Event subscriptions** — request URL `https://<your-domain>/slack/events`. Subscribe to `app_mention`, `message.channels`, `message.groups`, `reaction_added` (the last one for approval buttons is optional but nice).
3. **Interactivity** — request URL `https://<your-domain>/slack/interactivity`. This handles both approval button clicks and modal submissions.
4. **Bot scopes**: `app_mentions:read`, `channels:history`, `groups:history`, `chat:write`, `commands`, `im:write`, `users:read`, `users:read.email`, `files:read`, `reactions:read`, `reactions:write`.
5. Install (or reinstall) to your workspace to grant the scopes.

### Add source repos

```bash
docker compose exec remote-cli git clone https://github.com/your-org/your-repo.git /workspace/repos/your-repo
```

Every repo needs an entry in `docker-volumes/workspace/config.json`:

```jsonc
{
  "repos": {
    "your-repo": {
      "channels": ["C0AB12345"], // Slack channels this repo responds in
      "proxies": ["slack", "atlassian", "salesforce"],
    },
  },
  "support_team_emails": ["support-member-1@your-co.com", "support-member-2@your-co.com"],
  "katalon_email_suffixes": ["@your-co.com"],
  "proxies": {
    "salesforce": {
      "upstream": { "url": "http://salesforce-mcp:3005/mcp" },
      "access": "support",
      "per_user_creds": true,
      "allow": [
        "sf_fetch_case",
        "sf_soql_query",
        "sf_get_bulk_cases",
        "sf_list_attachments",
        "sf_get_attachment",
      ],
      "approve": [
        "sf_post_comment",
        "sf_update_status",
        "sf_update_jira_link",
        "sf_update_eta",
        "sf_post_internal_note",
      ],
    },
  },
}
```

Config is hot-reloaded on every proxy call. Adding a support teammate is one line; no restart.

### Enroll your first user

In Slack:

```
/kally connect salesforce
```

Fill the modal. Kally DMs you when creds are saved. Mention `@Kally` in your support channel and go.

## Security

Defense in depth. No component is trusted in isolation.

### Identity + access gating

Every `/trigger` carries `user_id` (Slack uid) and `user_email` (resolved via `users.info`, cached 24h). The gateway forwards them as `x-kally-user-slack-id` / `x-kally-user-email` headers through the proxy-cli / remote-cli wrappers. The proxy's **access gate** runs before any classification: `support` policies check an explicit allowlist, `katalon` policies check email domain, `public` allows anyone in an allowed channel. Denied requests never reach the upstream and return a friendly Slack-facing message.

### Per-user credentials

Two injection modes:

- **`args` mode (Salesforce)** — the proxy adds a reserved `_kally_auth` field to the MCP tool arguments. `salesforce-mcp` strips it and splices the creds into the `sf_ops.py` subprocess env for that single call. The session-token cache is disabled (`KALLY_SF_NO_CACHE=1`) so tokens never leak across users. Plaintext lifetime: one subprocess.
- **`connection` mode (Atlassian)** — the proxy maintains a per-user MCP connection pool. First call opens a fresh StreamableHTTP session with the user's Rovo token in the `Authorization` header; subsequent calls reuse. Idle-TTL eviction bounds memory (30 min). Invalidation endpoint drops cached sessions immediately after `/kally disconnect` or re-`/kally connect`.

Approve-classified calls (sf_post_comment, createJiraIssue, etc.) stamp the requester's uid onto the pending action. At resolve time the proxy re-fetches the **requester's** creds (not the reviewer's, not the container's) so an approved write authenticates as the person who proposed it.

### Vault

- AES-256-GCM authenticated encryption with a 32-byte master key from env. Fresh 12-byte IV per record; 16-byte auth tag detects any tampering.
- JSON-file store at `/workspace/vault/kally.json` with atomic rename + in-process mutex. Format version checked on every read so future schema changes fail loudly.
- Append-only JSONL audit at `/workspace/vault/audit.jsonl`: `{ts, action, slack_uid, provider, actor, purpose, ok, error?}`. Plaintext credentials are never logged.
- Bearer-auth on every endpoint (timing-safe compare). Internal-only: vault binds to the compose network, no host port.

### Tool policy

Every proxy instance loads an allow/approve policy:

- **allow** — tool is listed to the agent and runs immediately.
- **approve** — tool is listed, but each call creates a pending action the reviewer must approve (via Slack button) before it runs.
- **hidden** (anything not in either list) — never listed to the agent, never executed. Calling it returns `Unknown tool: <name>`.

Policy drift is validated at startup: allow-listed tools that don't exist on the upstream fail the container in production.

### Webhook auth

- Slack webhooks use HMAC-SHA256 with `timingSafeEqual` and configurable timestamp tolerance (default 300s).
- GitHub events arrive via a GitHub Actions workflow (`docs/notify-kally.example.yml`), not direct webhooks, so payloads arrive from a trusted CI context.

### Filesystem sandboxing

OpenCode's mounts are scoped:

| Mount                  | Access       | Purpose                                             |
| ---------------------- | ------------ | --------------------------------------------------- |
| `/workspace/cron`      | rw           | Crontab for scheduled jobs                          |
| `/workspace/memory`    | rw           | Persistent agent memory                             |
| `/workspace/repos`     | ro           | Source — the agent cannot edit via this mount       |
| `/workspace/worklog`   | ro           | Audit log — cannot be tampered with                 |
| `/workspace/worktrees` | rw           | Git worktrees for code changes                      |
| `/workspace/vault`     | (vault only) | Encrypted credentials, not accessible from opencode |

Non-root containers (uid/gid 1001 `kally`). All internal services bind to `127.0.0.1`; only the ingress is exposed.

## Observability

When `LANGSMITH_API_KEY` is set, the runner emits structured traces from its event stream:

- One **thread** per `correlationKey` (same Slack thread groups across triggers)
- One **root chain run** per `/trigger`
- Nested **LLM runs** per `step-finish` (tokens + cost attached)
- **Tool runs** for every completed tool part
- Subagent `task` tool calls become nested chain runs containing their own tool + LLM children
- Metadata: `user_id`, `user_email`, `repo`, `agent`, `event_source`, `model`, `directory`

When the key is unset, tracing is a no-op. Zero network, zero overhead.

Additionally every service emits structured JSON (pino) logs with `user_id` / `user_email` on every tool-level event. Vault writes an audit entry per credential access. Proxy writes a per-call worklog entry under `/workspace/worklog/<date>/`.

## Subagents

OpenCode subagents specialize the primary agent for repeatable workflows:

- **coder** — fast-model implementation across multiple files
- **thinker** — high-reasoning model for planning, review, hard debugging
- **runbook** — Salesforce case triage (on-hold / open / active, or deep-dive a single case)
- **create-ksr** — escalate an SF case to DEV via a Jira KSR with template-faithful ADF and the mandatory follow-up (status update, client-facing comment, SF↔Jira link)
- **knowledge-consolidation** — turn a resolved case into a Confluence KB article; checks existing coverage first
- **analyze-log** — download + scan SF attachments for known error signatures and matching live KSRs

Subagent definitions live in `docker/opencode/config/agents/`. The primary agent dispatches to them via OpenCode's `task` tool; each subagent call becomes its own session with its own LangSmith trace branch.

## Development

```bash
pnpm install

pnpm -r build              # build all packages
pnpm -r typecheck          # typecheck every package
pnpm test                  # run the vitest suite (370+ tests across 23 files)

# Bring the full stack up for iteration
docker compose up --build -d

# Tail service logs
docker compose logs -f gateway runner proxy vault salesforce-mcp
```

### Project layout

```
kally/
├── packages/
│   ├── common/               # shared: logger, schemas, vault client, tracing, access check
│   ├── vault/                # encrypted credential store + audit log
│   ├── gateway/              # Slack events, /kally slash commands, signature verification
│   ├── runner/               # OpenCode session lifecycle, NDJSON progress, LangSmith traces
│   ├── proxy/                # access gate, per-user creds, allow/approve policy, approvals
│   ├── slack-mcp/            # Slack MCP server + multimodal files + Block Kit footer
│   ├── salesforce-mcp/       # Salesforce MCP wrapping sf_ops.py
│   ├── opencode-cli/         # in-agent CLI wrappers (mcp, approval) that call proxy
│   └── remote-cli/           # sandboxed shell for git/gh/scoutqa/langfuse/metabase
├── docker/
│   ├── opencode/
│   │   ├── bin/              # /usr/local/bin/* wrappers injected into OpenCode container
│   │   └── config/
│   │       ├── agents/       # primary agent + 4 subagents (runbook, create-ksr, ...)
│   │       ├── plugins/      # kally.js: injects KALLY_USER_* into shell.env
│   │       └── skills/       # user-invocable skill packs
│   ├── ingress/              # nginx + Vouch
│   ├── cron/                 # crond for scheduled prompts
│   └── data/                 # internal API cred proxy
├── docs/                     # design docs, plans, feature specs
├── docker-compose.yml
├── Dockerfile                # multi-target build for every service
├── AGENTS.md                 # primary agent instructions (loaded by OpenCode)
└── CLAUDE.md                 # Claude Code project guidance (skill routing)
```

### Running the test suite

```bash
pnpm test                          # unit + integration, vitest
pnpm -F @kally/vault test          # just vault
pnpm -F @kally/proxy test          # just proxy
pnpm vitest run packages/common/src/access.test.ts   # specific test
```

## What's still rough

- **Salesforce OAuth web flow** — enrollment today asks for username+password+security-token. OAuth per-user would be nicer, requires Connected App redirect handler. Tracked as Phase 4.
- **Cron service-account identity** — cron-triggered sessions run with `user_id: "kally-cron"`; they can't authenticate against Salesforce as any specific user. If cron needs SF write access, add a vault entry under that uid or explicitly accept the shared-service-account audit trail.
- **Approval card re-post on restart** — if the proxy crashes after queueing an approval but before the card reaches Slack, the action is persisted but the button never appears. Currently recoverable via manual `POST /approval` to slack-mcp; needs proxy-side reconciliation on startup.
- **Rate limiting on slash commands** — no per-user rate limit on `/kally connect`. Not critical (the vault will reject malformed creds anyway), but worth adding before a larger rollout.

## License

Internal tooling. Not licensed for external distribution.
