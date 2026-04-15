# Unified multi-target Dockerfile for all Kally Node.js services.
# Shared deps and build stages mean pnpm install runs once, not per-service.
#
# Usage in docker-compose.yml:
#   build:
#     context: .
#     target: gateway

FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
RUN groupadd --gid 1001 kally && useradd --uid 1001 --gid kally --create-home kally
RUN mkdir -p /workspace && chown kally:kally /workspace

# --- Install deps (cached until lockfile or package.json changes) ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsup.config.ts ./
COPY packages/common/package.json packages/common/
COPY packages/gateway/package.json packages/gateway/
COPY packages/proxy/package.json packages/proxy/
COPY packages/runner/package.json packages/runner/
COPY packages/slack-mcp/package.json packages/slack-mcp/
COPY packages/salesforce-mcp/package.json packages/salesforce-mcp/
COPY packages/remote-cli/package.json packages/remote-cli/
COPY packages/opencode-cli/package.json packages/opencode-cli/
COPY packages/vault/package.json packages/vault/
RUN pnpm install --frozen-lockfile

# --- Build all packages ---
FROM deps AS build
COPY packages/ packages/
RUN pnpm -r build

# === Per-service targets ===

FROM build AS gateway
USER kally
WORKDIR /workspace
ENV PORT=3002
EXPOSE 3002
CMD ["node", "/app/packages/gateway/dist/index.js"]

FROM build AS proxy
USER kally
WORKDIR /workspace
EXPOSE 3001
CMD ["node", "/app/packages/proxy/dist/index.js"]

FROM build AS runner
USER kally
WORKDIR /workspace
ENV PORT=3000
EXPOSE 3000
CMD ["node", "/app/packages/runner/dist/index.js"]

FROM build AS slack-mcp
USER kally
ENV PORT=3003
EXPOSE 3003
CMD ["node", "/app/packages/slack-mcp/dist/index.js"]

FROM build AS vault
USER kally
WORKDIR /workspace
ENV PORT=3006
EXPOSE 3006
CMD ["node", "/app/packages/vault/dist/index.js"]

FROM build AS salesforce-mcp
# Install Python 3 + pip for sf_ops.py subprocess (requests, python-dotenv)
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/sf-venv \
    && /opt/sf-venv/bin/pip install --no-cache-dir -r /app/packages/salesforce-mcp/requirements.txt \
    && chown -R kally:kally /opt/sf-venv
ENV PYTHON_BIN=/opt/sf-venv/bin/python3
ENV SF_OPS_PATH=/app/packages/salesforce-mcp/sf_ops.py
USER kally
ENV PORT=3005
EXPOSE 3005
CMD ["node", "/app/packages/salesforce-mcp/dist/index.js"]

# --- Install upstream opencode from npm ---
FROM base AS opencode
RUN npm install -g opencode-ai@1.4.3
# git/gh/scoutqa wrapper scripts — forward to remote-cli service over HTTP
COPY --from=build /app/packages/opencode-cli/dist/remote-cli.mjs /usr/local/bin/remote-cli.mjs
COPY docker/opencode/bin/git /usr/local/bin/git
COPY docker/opencode/bin/gh /usr/local/bin/gh
COPY docker/opencode/bin/scoutqa /usr/local/bin/scoutqa
COPY docker/opencode/bin/langfuse /usr/local/bin/langfuse
COPY docker/opencode/bin/metabase /usr/local/bin/metabase
# mcp/approval wrapper scripts — forward to proxy service over HTTP
COPY --from=build /app/packages/opencode-cli/dist/proxy-cli.mjs /usr/local/bin/proxy-cli.mjs
COPY docker/opencode/bin/mcp /usr/local/bin/mcp
COPY docker/opencode/bin/approval /usr/local/bin/approval
USER kally
RUN mkdir -p /home/kally/.local/share/opencode /home/kally/.local/state
ENV KALLY_REMOTE_CLI_URL=http://remote-cli:3004
ENV KALLY_PROXY_URL=http://proxy:3001
# Disable the question tool — it requires an interactive client to answer.
# OpenCode only registers QuestionTool when OPENCODE_CLIENT is "app", "cli", or "desktop".
# https://github.com/sst/opencode/blob/main/packages/opencode/src/tool/registry.ts
ENV OPENCODE_CLIENT=kally
# config/ holds agents, plugins, opencode.json, and skills in the new layout
COPY --chown=kally:kally docker/opencode/config/ /home/kally/.config/opencode/
ENTRYPOINT ["opencode"]

FROM build AS remote-cli
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
RUN npm i -g @scoutqa/cli@latest langfuse-cli@0.0.8
COPY packages/remote-cli/entrypoint.sh /entrypoint.sh
USER kally
RUN mkdir -p /workspace/repos
WORKDIR /workspace/repos
ENV PORT=3004
EXPOSE 3004
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/packages/remote-cli/dist/index.js"]
