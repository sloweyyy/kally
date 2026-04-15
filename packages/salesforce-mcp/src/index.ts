import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createLogger, logInfo, logError } from "@kally/common";
import { runSfOps, formatResult, type SfRequestAuth } from "./salesforce.js";

/**
 * Strip the proxy-injected `_kally_auth` field from tool arguments and
 * return it as typed credentials. Kally's proxy sets `_kally_auth` when
 * the workspace config has `per_user_creds: true`; each such call is
 * authenticated as the triggering Slack user rather than the shared
 * container env. Returning a fresh args object guarantees the reserved
 * key never reaches sf_ops.py.
 */
function extractKallyAuth(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  auth?: SfRequestAuth;
} {
  const raw = args._kally_auth;
  if (!raw || typeof raw !== "object") return { args };
  // Remove the reserved key from the args we forward.
  const { _kally_auth: _ignored, ...rest } = args;
  const obj = raw as Record<string, unknown>;
  const auth: SfRequestAuth = {
    client_id: typeof obj.client_id === "string" ? obj.client_id : undefined,
    client_secret: typeof obj.client_secret === "string" ? obj.client_secret : undefined,
    username: typeof obj.username === "string" ? obj.username : undefined,
    password: typeof obj.password === "string" ? obj.password : undefined,
    instance_url: typeof obj.instance_url === "string" ? obj.instance_url : undefined,
  };
  return { args: rest, auth };
}

const log = createLogger("salesforce-mcp");
const PORT = parseInt(process.env.PORT || "3005", 10);

// --- Required env for sf_ops.py ---
const REQUIRED_ENV = [
  "SALESFORCE_CLIENT_ID",
  "SALESFORCE_CLIENT_SECRET",
  "SALESFORCE_USERNAME",
  "SALESFORCE_PASSWORD",
  "SALESFORCE_INSTANCE_URL",
];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    logError(log, "missing_env", `${k} is required`);
  }
}

// --- Tool definitions (the core 7 for Phase 1) ---

const tools: Tool[] = [
  {
    name: "sf_fetch_case",
    description:
      "Fetch a Salesforce case by case number. Returns case details, feed, comments, and emails as JSON. Use for deep-dive on a single case.",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "Case number (e.g. '00046132' or '00045276')",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "sf_soql_query",
    description:
      "Run an arbitrary SOQL query against Salesforce. Returns the raw query result as JSON.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            'SOQL query string (e.g. "SELECT Id,CaseNumber,Status FROM Case WHERE IsClosed=false LIMIT 10")',
        },
      },
      required: ["query"],
    },
  },
  {
    name: "sf_get_bulk_cases",
    description:
      "List cases in bulk filtered by status mode (on-hold, on-hold-bug, open, active) and optional owner email. Returns summary data for triage workflows.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          description: "Status mode: 'on-hold', 'on-hold-bug', 'open', 'active'",
        },
        email: {
          type: "string",
          description:
            "Owner email (e.g. 'phuc.truong@katalon.com'). Optional — defaults to authenticated user.",
        },
      },
      required: ["mode"],
    },
  },
  {
    name: "sf_post_comment",
    description:
      "Post a public comment (FeedComment) to a Salesforce case. Visible to clients. Use for client-facing responses.",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_id: {
          type: "string",
          description: "Salesforce case ID (18-char)",
        },
        body: {
          type: "string",
          description: "Comment body (plain text or Chatter-compatible markup)",
        },
      },
      required: ["case_id", "body"],
    },
  },
  {
    name: "sf_update_status",
    description:
      "Update the Status field of a Salesforce case. Common statuses: 'Pending', 'On-Hold Bug Report', 'Open', 'Closed'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_id: {
          type: "string",
          description: "Salesforce case ID (18-char)",
        },
        status: {
          type: "string",
          description: "New status value",
        },
      },
      required: ["case_id", "status"],
    },
  },
  {
    name: "sf_update_jira_link",
    description:
      "Link a Salesforce case to a Jira issue by setting the case's Jira link field. Used when escalating to DEV via KSR.",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_id: {
          type: "string",
          description: "Salesforce case ID (18-char)",
        },
        jira_key: {
          type: "string",
          description: "Jira issue key (e.g. 'KSR-9761')",
        },
      },
      required: ["case_id", "jira_key"],
    },
  },
  {
    name: "sf_list_attachments",
    description:
      "List all ContentDocumentLink attachments on a Salesforce case. Returns filename, mimetype, size, and ContentVersion ID for each. Use before downloading a specific attachment.",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_id: {
          type: "string",
          description: "Salesforce case ID (18-char)",
        },
      },
      required: ["case_id"],
    },
  },
  {
    name: "sf_get_attachment",
    description:
      "Download the binary content of a Salesforce ContentVersion (attachment) to a local path. Use for reading log files or diagnostic files attached to cases. Call sf_list_attachments first to get version IDs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        version_id: {
          type: "string",
          description: "18-char ContentVersion Id (from sf_list_attachments)",
        },
        save_to: {
          type: "string",
          description:
            "Absolute path to save the file (e.g. '/tmp/case-12345-logs.zip'). Must be in /tmp or the current workspace.",
        },
      },
      required: ["version_id", "save_to"],
    },
  },
  {
    name: "sf_update_eta",
    description:
      "Update the ETA and/or Fix Version fields on a Salesforce case. Used for on-hold bug cases where DEV provides a target release date.",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_id: {
          type: "string",
          description: "Salesforce case ID (18-char)",
        },
        eta: {
          type: "string",
          description: "ETA string (e.g. 'April 1, 2026'). Optional if fix_version is provided.",
        },
        fix_version: {
          type: "string",
          description: "Fix version string (e.g. '11.1.0'). Optional if eta is provided.",
        },
      },
      required: ["case_id"],
    },
  },
  {
    name: "sf_post_internal_note",
    description:
      "Post an internal-only note (FeedItem, visible only to Katalon internal users) on a Salesforce case. NOT visible to clients. Use for internal handoff notes, triage decisions, or context for the next agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_id: {
          type: "string",
          description: "Salesforce case ID (18-char)",
        },
        body: {
          type: "string",
          description: "Internal note body (plain text)",
        },
        mention_user_id: {
          type: "string",
          description:
            "Optional: 18-char SF User Id to @mention in the note (triggers notification to that user)",
        },
      },
      required: ["case_id", "body"],
    },
  },
];

// --- Tool dispatch ---

async function handleToolCall(name: string, rawArgs: Record<string, unknown>) {
  const { args, auth } = extractKallyAuth(rawArgs);
  const DEFAULT_TIMEOUT = 60_000;
  switch (name) {
    case "sf_fetch_case":
      return formatResult(
        await runSfOps(["--case", String(args.case_number)], DEFAULT_TIMEOUT, auth),
      );
    case "sf_soql_query":
      return formatResult(await runSfOps(["--soql", String(args.query)], DEFAULT_TIMEOUT, auth));
    case "sf_get_bulk_cases": {
      const cli = ["--mode", String(args.mode)];
      if (args.email) cli.push("--email", String(args.email));
      return formatResult(await runSfOps(cli, DEFAULT_TIMEOUT, auth));
    }
    case "sf_post_comment":
      return formatResult(
        await runSfOps(
          [
            "--post-comment",
            "--case-id",
            String(args.case_id),
            "--comment-body",
            String(args.body),
          ],
          DEFAULT_TIMEOUT,
          auth,
        ),
      );
    case "sf_update_status":
      return formatResult(
        await runSfOps(
          ["--update-status", "--case-id", String(args.case_id), "--status", String(args.status)],
          DEFAULT_TIMEOUT,
          auth,
        ),
      );
    case "sf_update_jira_link":
      return formatResult(
        await runSfOps(
          [
            "--update-jira-link",
            "--case-id",
            String(args.case_id),
            "--jira-key",
            String(args.jira_key),
          ],
          DEFAULT_TIMEOUT,
          auth,
        ),
      );
    case "sf_list_attachments":
      return formatResult(
        await runSfOps(
          ["--list-attachments", "--case-id", String(args.case_id)],
          DEFAULT_TIMEOUT,
          auth,
        ),
      );
    case "sf_get_attachment":
      return formatResult(
        await runSfOps(
          [
            "--get-attachment",
            "--version-id",
            String(args.version_id),
            "--save-to",
            String(args.save_to),
          ],
          DEFAULT_TIMEOUT,
          auth,
        ),
      );
    case "sf_update_eta": {
      const cli = ["--update-eta", "--case-id", String(args.case_id)];
      if (args.eta) cli.push("--eta", String(args.eta));
      if (args.fix_version) cli.push("--fix-version", String(args.fix_version));
      return formatResult(await runSfOps(cli, DEFAULT_TIMEOUT, auth));
    }
    case "sf_post_internal_note": {
      const cli = [
        "--post-internal-note",
        "--case-id",
        String(args.case_id),
        "--comment-body",
        String(args.body),
      ];
      if (args.mention_user_id) cli.push("--mention-user-id", String(args.mention_user_id));
      return formatResult(await runSfOps(cli, DEFAULT_TIMEOUT, auth));
    }
    default:
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

// --- MCP server factory ---

function createSalesforceMcpServer(): Server {
  const server = new Server(
    { name: "kally-salesforce-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await handleToolCall(toolName, args);
    } catch (err) {
      logError(log, "tool_call_error", err instanceof Error ? err.message : String(err), {
        tool: toolName,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// --- Express app + StreamableHTTP MCP transport ---

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "salesforce-mcp", tools: tools.length });
});

const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const body = req.body;
    if (body?.method === "initialize") {
      const newSessionId = randomUUID();
      const server = createSalesforceMcpServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
          logInfo(log, "session_created", { sessionId: sid });
        },
      });

      transport.onclose = () => {
        transports.delete(newSessionId);
        logInfo(log, "session_closed", { sessionId: newSessionId });
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({ error: "No valid session. Send an initialize request first." });
  } catch (err) {
    logError(log, "mcp_request_error", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No valid session." });
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "No valid session." });
});

app.listen(PORT, () => {
  logInfo(log, "salesforce_mcp_listening", {
    port: PORT,
    tools: tools.map((t) => t.name),
  });
});
