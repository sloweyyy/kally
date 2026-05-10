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
import { runDriveOps, formatResult } from "./google-ops.js";

const log = createLogger("google-mcp");
const PORT = parseInt(process.env.PORT || "3008", 10);

// ── Tool definitions ────────────────────────────────────────────────

const tools: Tool[] = [
  {
    name: "drive_create_folder",
    description: "Create a folder in Google Drive under a specified parent folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        folder_name: {
          type: "string",
          description: "Folder name",
        },
        parent_folder_id: {
          type: "string",
          description: "Parent folder ID",
        },
      },
      required: ["folder_name", "parent_folder_id"],
    },
  },
  {
    name: "drive_upload_file",
    description: "Upload a local file to a Google Drive folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        folder_id: {
          type: "string",
          description: "Target Drive folder ID",
        },
        file_path: {
          type: "string",
          description: "Absolute path to the local file",
        },
        file_name: {
          type: "string",
          description: "Override the uploaded file name (optional)",
        },
      },
      required: ["folder_id", "file_path"],
    },
  },
  {
    name: "drive_upload_base64",
    description:
      "Upload a file from base64-encoded content to Google Drive. Use for files fetched as base64 (e.g. screenshots from Slack via get_slack_file).",
    inputSchema: {
      type: "object" as const,
      properties: {
        folder_id: {
          type: "string",
          description: "Target Drive folder ID",
        },
        file_name: {
          type: "string",
          description: "File name for the upload (e.g. 'screenshot-1.png')",
        },
        mime_type: {
          type: "string",
          description: "MIME type (e.g. 'image/png', 'image/jpeg')",
        },
        base64_data: {
          type: "string",
          description: "Base64-encoded file content",
        },
      },
      required: ["folder_id", "file_name", "mime_type", "base64_data"],
    },
  },
  {
    name: "drive_list_files",
    description: "List files in a Google Drive folder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        folder_id: {
          type: "string",
          description: "Drive folder ID to list",
        },
      },
      required: ["folder_id"],
    },
  },
];

// ── Tool handler ────────────────────────────────────────────────────

async function handleToolCall(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "drive_create_folder": {
      return formatResult(
        await runDriveOps([
          "--create-folder",
          "--parent-id",
          String(args.parent_folder_id),
          "--name",
          String(args.folder_name),
        ]),
      );
    }

    case "drive_upload_file": {
      const cli = [
        "--upload-file",
        "--folder-id",
        String(args.folder_id),
        "--file-path",
        String(args.file_path),
      ];
      if (args.file_name) cli.push("--file-name", String(args.file_name));
      return formatResult(await runDriveOps(cli));
    }

    case "drive_upload_base64": {
      const b64 = String(args.base64_data);
      return formatResult(
        await runDriveOps(
          [
            "--upload-base64",
            "--folder-id",
            String(args.folder_id),
            "--file-name",
            String(args.file_name),
            "--mime-type",
            String(args.mime_type),
            "--base64-stdin",
          ],
          120_000,
          b64,
        ),
      );
    }

    case "drive_list_files": {
      return formatResult(
        await runDriveOps(["--list-files", "--folder-id", String(args.folder_id)]),
      );
    }

    default:
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

// ── MCP server factory ──────────────────────────────────────────────

function createGoogleMcpServer(): Server {
  const server = new Server(
    { name: "kally-google-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await handleToolCall(toolName, rawArgs);
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

// ── Express app + StreamableHTTP MCP transport ──────────────────────

const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "google-mcp", tools: tools.length });
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
      const server = createGoogleMcpServer();

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

// ── Startup ─────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logInfo(log, "google_mcp_listening", {
    port: PORT,
    tools: tools.map((t) => t.name),
  });
});
