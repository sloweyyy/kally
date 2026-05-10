# Kally

> An ambient AI teammate that lives in Slack, acts on Salesforce / Jira / Confluence as the human who summoned it, and keeps every action attributable, auditable, and revocable.

[![CI](https://github.com/sloweyyy/kally/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/sloweyyy/kally/actions/workflows/unit-tests.yml)
[![Deploy](https://github.com/sloweyyy/kally/actions/workflows/deploy.yml/badge.svg)](https://github.com/sloweyyy/kally/actions/workflows/deploy.yml)
[![Node](https://img.shields.io/badge/node-24-blue?logo=node.js)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.33-orange?logo=pnpm)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Cloud Run](https://img.shields.io/badge/Cloud_Run-deployed-4285F4?logo=googlecloud)](https://cloud.google.com/run)

```
11 packages   ·   45 test files   ·   733 tests   ·   ~39k lines of TypeScript
9 services on Cloud Run   ·   1 multi-container with opencode sidecar
```

## Why this exists

You mention `@Kally` in Slack. It triages your Salesforce queue, escalates to Jira, drafts the Confluence KB article, runs a SOQL query, scans a 50 MB log bundle for known signatures, **opens a PR worktree to review code, replies inline on review threads, watches CI on commits it authored, and fixes its own failures** — anything an LLM with the right tools can do. Every write goes through an in-channel approval card. Every action authenticates as **you**, not a shared service account, even if the reviewer was someone else. Every credential is encrypted at rest and revocable with one slash command.

```
# Slack surface
@Kally triage my open cases
@Kally create a KSR for SF00046518
@Kally analyze the log on SF00046155
@Kally write a KB from SF00045276

# GitHub surface
"@Kally please review"     ← inline PR comment, Kally checks out a worktree and replies
push to a tracked branch   ← worktree fast-forwarded or hard-reset by classification
CI failed on Kally's commit ← pulls failed logs, fixes, pushes, lets next CI verify
```

## Architecture

```
                   Slack workspace
                 (events, commands, modals)
                          │
                          ▼
                   ┌─────────────┐
                   │   gateway   │  ← Slack signature verify, slash commands,
                   │             │    /kally connect modal flow, event batcher
                   └──────┬──────┘
                          │  /trigger { user_id, user_email, prompt }
                          ▼
                   ┌─────────────┐    spawns/resumes
                   │   runner    │ ───────────────┐
                   │   sessions  │                ▼
                   └──────┬──────┘         ┌──────────────┐
                          │                │   opencode   │
                          │ NDJSON         │  AI runtime  │
                          │ progress       │ (subagents)  │
                          ▼                └──────┬───────┘
                       Slack                     │ MCP, bash, git, gh
                                                 ▼
                                  ┌────────────────────────────┐
                                  │      remote-cli (proxy)    │
                                  │  • access policy gate      │
                                  │  • per-user creds inject   │
                                  │  • approval queue          │
                                  └─┬────────┬──────────┬──────┘
                                    │        │          │
                            ┌───────▼─┐ ┌────▼──────┐ ┌─▼────────────┐
                            │  vault  │ │ Atlassian │ │  Salesforce  │
                            │ AES-GCM │ │   MCP     │ │     MCP      │
                            │  audit  │ │ (hosted)  │ │   (Kally)    │
                            └─────────┘ └───────────┘ └──────────────┘
```

**Trust boundary:** the proxy. Opencode never sees plaintext credentials in its context — they're spliced into MCP tool args at the proxy layer or baked into per-user MCP transport headers, then immediately discarded.

## What's interesting in here

### Two credential-injection modes for two API shapes

```ts
// args mode — Salesforce. Kally-owned MCP server.
//   Proxy adds a reserved `_kally_auth` field to tool args; the MCP
//   server strips it and splices into a one-shot subprocess env.
//   Plaintext lifetime: a single Python invocation.
{ tool: "sf_fetch_case", args: { case_id: "...", _kally_auth: { ... } } }

// connection mode — Atlassian. Hosted third-party MCP.
//   Proxy maintains a per-user MCP connection pool; first call opens a
//   fresh StreamableHTTP session with the user's token in the
//   Authorization header. 30 min idle TTL. Invalidation endpoint drops
//   cached sessions on /kally disconnect.
```

### Approval flow that doesn't lie about identity

When an `approve`-classified tool fires, the pending action stamps the **requester's** Slack uid. At resolve time the proxy re-fetches the requester's vault credentials — not the reviewer's, not the container's. So an approved Jira write authenticates as the person who proposed it, weeks-old approvals included.

### Three-tier access policy enforced before the upstream is touched

```jsonc
"proxies": {
  "salesforce": { "access": "support",  ... },  // explicit allowlist
  "atlassian":  { "access": "katalon",  ... },  // email-suffix domain check
  "slack":      { "access": "public",   ... }   // any allowed-channel member
}
```

Denied requests never reach the upstream. They get a friendly Slack-facing message naming the policy that blocked them.

### Vault that earns its name

```
vault.json                            audit.jsonl
─────────                             ──────────
{                                     {"ts": "...", "action": "get",
  "version": 1,                        "slack_uid": "U_TEST_BOT",
  "creds": {                           "provider": "salesforce",
    "U_TEST_BOT:salesforce": {         "actor": "remote-cli",
      "iv":  "AES-GCM nonce",          "purpose": "sf_fetch_case",
      "ciphertext": "...",             "ok": true}
      "tag": "auth tag",              {...}
      ...                             {...}
    }
  }
}
```

- **AES-256-GCM** with a 32-byte master key from env. Fresh 12-byte IV per record. Auth tag detects tampering. Plaintext exists only for the single subprocess that consumes it.
- **Append-only audit** logs every read with who/when/what/why. Plaintext credentials never appear in the log.
- **Bearer-auth** on every endpoint with `timingSafeEqual`. Internal-only — vault binds to the compose network with no host port.

### LLM observability that survives reality

When `LANGSMITH_API_KEY` is set, the runner emits a structured trace tree from its NDJSON event stream:

```
thread (per Slack thread, groups across triggers)
└── chain run (per /trigger)
    ├── llm run (per step-finish — tokens + cost attached)
    ├── tool run (per completed tool part)
    └── chain run (per task-tool subagent call)
        ├── llm run
        └── tool run
```

User identity, repo, agent, model, channel — all attached as searchable metadata. When the key is unset, tracing is a no-op. Zero network, zero overhead.

### Multimodal file handling on Slack

`get_slack_file` returns a tagged union: `image` (vision content), `text` (raw), `pdf` (extracted text), `zip` (manifest with small text entries inlined). Default 5 MB cap, hard cap 50 MB. The agent sees a 32 MB log bundle as a structured document, not a base64 wall.

### GitHub events that wake the agent (six types, each with its own gate)

The gateway pre-filters webhooks before waking opencode. Each event type carries its own short-circuit logic so the agent only resumes for things it actually needs to act on:

| Event | What the gateway does | What Kally does on wake |
|---|---|---|
| `issue_comment.created` | Mention-gate; ignore PR-bot comments | Replies in-thread via `gh pr comment <N>` |
| `pull_request_review_comment.created` | Inline review comment on a tracked PR | Replies on the same thread via `gh api ... in_reply_to=<id>` (not a new top-level comment) |
| `pull_request_review.submitted` | Full review with non-empty body | Reads `review.state` (approved / changes_requested / commented), addresses inline specifics |
| `push` | Compares local HEAD to `event.after`; fast-forward vs divergent classified via `git merge-base --is-ancestor`. Worktree hard-reset to FETCH_HEAD, divergent pushes flagged as **interrupts** | Re-reads HEAD if interrupt, otherwise continues |
| `check_suite.completed` | Bot-authored CI gate | Per-conclusion handling: `success` = log only; `failure` = pull failed logs, classify defect vs flake, fix and push (max 3 autonomous attempts/branch), or escalate to Slack thread |
| `pull_request.closed` | Tracks `pull_request.merged` flag | Stops pushing to merged branch; records outcome |

Same-correlation-key events get debounced over 3 s, so a Slack-style submitted-review-with-inline-comments arrives as one logical message.

### PR review protocol that doesn't fake context

When Kally is asked to review a PR, the **first action** is always to check out the branch to a real worktree:

```bash
git fetch origin pull/<N>/head:pr-<N>
git worktree add /workspace/worktrees/<repo>/pr-<N> pr-<N>
```

Then every diff, grep, test, type-check, and file read happens against the worktree. Reviewing via `gh pr diff` alone is forbidden — it produces shallow reviews because you can't run the test suite, can't grep beyond changed lines for callers, and can't reproduce the build. If a worktree already exists at `/workspace/worktrees/<repo>/<branch>` (because the agent has been on this branch before), it's reused.

### Tools the agent can pick up

Each tool is wired in as either an MCP server (per-user creds, allow/approve policy) or a vetted CLI wrapper that forwards over HTTP to `remote-cli`. Adding a new one is `proxies.ts` + a wrapper script.

**Code & repo**
- `git` (with disclaimer-injecting wrapper for PR/comment writes)
- `gh` (GitHub CLI — PRs, reviews, comments, releases, runs)
- `scoutqa` — browser-driven QA: navigate, click, screenshot, assert. Used for UI smoke testing on agent-built changes.

**Knowledge & tickets**
- Atlassian MCP (hosted): Jira issue CRUD, JQL search, Confluence page CRUD, CQL search, search/fetch — full Rovo MCP surface, per-user OAuth via Rovo API token
- Salesforce MCP (Kally-owned): 10 tools — `sf_fetch_case`, `sf_soql_query`, `sf_get_bulk_cases`, `sf_list_attachments`, `sf_get_attachment`, `sf_post_comment`, `sf_update_status`, `sf_update_jira_link`, `sf_update_eta`, `sf_post_internal_note`. Approve-gated writes; per-user creds via `args` injection.
- Google MCP (Kally-owned): Drive file ops — search, read, copy, list, metadata.

**Observability**
- `langfuse` — query past LLM traces by user / session / time. Lets the agent answer "what did I do last Tuesday and why?"
- `metabase` — warehouse SQL via Metabase API. Schemas allowlisted via `METABASE_ALLOWED_SCHEMAS`; the agent can compose ad-hoc queries against your data warehouse without exposing credentials.
- Grafana MCP — metrics queries via Grafana's own MCP server.
- PostHog MCP — analytics queries (events, retention, funnels).

**Operations**
- `ldcli` — LaunchDarkly feature flag inspection (read-only). The agent can answer "which flags is user X in?" without dashboard access.
- `sandbox` — Daytona-managed polyglot container for `pnpm install && pnpm test`-style commands the agent shouldn't run on the host.
- `slack-post-message`, `slack-upload` — direct Slack write tools, separate from the MCP proxy path so the agent can post to channels it isn't proxying.
- `mcp`, `approval` — the agent's own self-administration CLI (list configured tools, check approval queue state).

**Generic shell** (in the opencode container itself)
- `node`, `bash`, `curl`, `jq`, `rg` (ripgrep), `prettier`, `ruff`, `shfmt`. Anything heavier (`pnpm`, `npm`, `npx`, `corepack`) is redirected to the sandbox.

### Sandbox execution for builds Kally doesn't trust

`npm`, `npx`, `pnpm`, `pnpx`, `corepack` in the opencode container are wrappers that redirect to a Daytona-managed cloud sandbox. The agent calls `pnpm install && pnpm test` and the actual install + test run lands in an isolated polyglot container (Node 20/22, Java 17/21, Python 3.12, Docker-in-Docker), not the agent's host. Bundle sync is delta over a managed git remote. Output streams back as NDJSON.

### Multi-container Cloud Run for the runner

The runner needs an opencode-ai server on `localhost:4096`. Cloud Run gen2 multi-container puts the opencode sidecar in the same pod, sharing a Cloud Storage FUSE-mounted `/workspace` volume. Auth.json comes from Secret Manager, copied into the sidecar's home dir at startup so the read-only mount doesn't break opencode's log dir creation.

### CI/CD via Workload Identity Federation

No JSON keys in the repo or in GitHub secrets. GitHub OIDC tokens get exchanged for short-lived GCP credentials via `google-github-actions/auth@v2`, scoped via `attribute.repository=sloweyyy/kally` so only this repo's actions can impersonate the deployer SA. The deploy workflow builds 7 service images + opencode sidecar via Cloud Build, rolls each Cloud Run service forward, and smoke-tests `gateway/health` before exiting green.

## Tech stack

| Layer | Choices |
|---|---|
| **Runtime** | Node.js 24, pnpm 10 workspace, TypeScript strict |
| **Framework** | Express + Zod (schemas everywhere), MCP SDK |
| **AI** | OpenCode (multi-agent runtime), Anthropic / OpenAI / Google models, LangSmith tracing |
| **Crypto** | AES-256-GCM (`node:crypto`), HMAC-SHA256 timing-safe Slack signatures |
| **Tests** | Vitest, 733 / 733 passing |
| **Build** | Multi-stage Docker with BuildKit cache mounts, per-package targets |
| **Local dev** | Docker Compose (12 services) with healthcheck + dependency ordering |
| **Production** | Cloud Run (gen2 + multi-container), Artifact Registry, Cloud Build |
| **Storage** | Cloud Storage FUSE for shared `/workspace`, Secret Manager for creds |
| **Auth** | Workload Identity Federation for CI → GCP |
| **CI** | GitHub Actions: unit tests, core e2e, sandbox e2e (Daytona), deploy |
| **Sandbox** | Daytona-managed polyglot containers (Node, Java, Python, Docker-in-Docker) for agent code execution |

## Services

| Service | Port | Package | Role |
|---|---|---|---|
| **gateway** | 3002 | `@kally/gateway` | Slack events + slash commands, signature verify, modal flow |
| **runner** | 3000 | `@kally/runner` | Session lifecycle, NDJSON progress, LangSmith trace emission |
| **opencode** | 4096 | `opencode-ai@1.14.39` | AI runtime + 4 subagents (runbook, create-ksr, KB, analyze-log) |
| **remote-cli** | 3004 | `@kally/remote-cli` | Sandboxed shell + MCP proxy with access policy + approval queue |
| **vault** | 3006 | `@kally/vault` | AES-256-GCM credential store + append-only audit |
| **slack-mcp** | 3003 | `@kally/slack-mcp` | Slack MCP with multimodal files (PDF / ZIP / images, up to 50 MB) |
| **salesforce-mcp** | 3005 | `@kally/salesforce-mcp` | 10 SF tools wrapping `sf_ops.py` |
| **google-mcp** | 3008 | `@kally/google-mcp` | Google Drive MCP |
| **admin** | 3007 | `@kally/admin` | Web UI for ops |
| **grafana-mcp** | 8000 | external | Metrics queries via Grafana MCP |
| **mitmproxy** | 8081 | python | HTTP debug proxy for agent egress inspection |

## Quick start

```bash
# Local dev
cp .env.example .env       # fill in SLACK_*, KALLY_VAULT_*, CRON_SECRET, etc.
docker compose up --build -d
curl http://localhost:3002/health

# Single-pass deploy to Cloud Run
gh workflow run "Deploy to Cloud Run" --ref main
```

CI/CD setup (one-time, ~5 min): see [`docs/cicd-setup.md`](docs/cicd-setup.md). Slack app config: see the **Slack app setup** section below.

### Slack app setup

| Slack feature | Request URL |
|---|---|
| Slash command `/kally` | `https://<your-domain>/slack/commands` |
| Event subscriptions | `https://<your-domain>/slack/events` |
| Interactivity | `https://<your-domain>/slack/interactivity` |

Bot scopes: `app_mentions:read`, `channels:history`, `groups:history`, `chat:write`, `commands`, `im:write`, `users:read`, `users:read.email`, `files:read`, `reactions:read`, `reactions:write`.

### Workspace config

Per-repo channel routing + per-proxy access policies live in `docker-volumes/workspace/config.json`:

```jsonc
{
  "repos": {
    "your-repo": {
      "channels": ["C0AB12345"],
      "proxies": ["slack", "atlassian", "salesforce"]
    }
  },
  "support_team_emails": ["alice@your-co.com", "bob@your-co.com"],
  "katalon_email_suffixes": ["@your-co.com"]
}
```

Hot-reloaded on every proxy call. No restart to add a teammate.

### Enroll a user

```
/kally connect salesforce      → modal → save creds
/kally connect atlassian       → modal → save Rovo MCP token
/kally status                  → list enrolled services
/kally disconnect <service>    → revoke (cached sessions invalidated immediately)
```

## Project layout

```
kally/
├── packages/
│   ├── common/             shared: logger, schemas, vault client, tracing, access check
│   ├── vault/              encrypted credential store + audit
│   ├── gateway/            Slack events, /kally commands, modal flow
│   ├── runner/             OpenCode session lifecycle, LangSmith tracing
│   ├── remote-cli/         MCP proxy + access gate + approval queue + sandboxed shell
│   ├── slack-mcp/          Slack MCP with multimodal file handling
│   ├── salesforce-mcp/     SF MCP server wrapping sf_ops.py
│   ├── google-mcp/         Google Drive MCP
│   ├── opencode-cli/       in-agent CLI wrappers (mcp, approval) → remote-cli over HTTP
│   └── admin/              ops web UI
├── docker/
│   ├── opencode/
│   │   ├── bin/            shell wrappers (git, gh, mcp, sandbox, slack-post-message)
│   │   └── config/agents/  primary agent + 4 subagents
│   ├── sandbox/            polyglot Daytona image (Node/Java/Python/Docker)
│   ├── ingress/            nginx
│   └── mitmproxy/          HTTP debug
├── scripts/
│   └── deploy/             render-runner-yaml.py (multi-container image bumper)
├── docker-compose.yml
├── Dockerfile              multi-target: gateway / runner / opencode / remote-cli / etc.
├── cloudbuild.yaml         all 7 service images, BuildKit + cache mounts
├── cloudbuild-opencode.yaml
└── .github/workflows/
    ├── unit-tests.yml      pnpm test on every PR
    ├── core-e2e.yml        compose-based e2e
    ├── sandbox-e2e.yml     polyglot sandbox image build + Daytona snapshot
    └── deploy.yml          WIF auth → Cloud Build → Cloud Run rollout
```

## Development

```bash
pnpm install
pnpm -r build        # all packages
pnpm -r typecheck    # all packages, strict
pnpm test            # 733 tests across 45 files

docker compose up --build -d
docker compose logs -f gateway runner remote-cli vault
```

## License

MIT.
