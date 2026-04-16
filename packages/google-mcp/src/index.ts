import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createLogger, logInfo, logError } from "@kally/common";
import { runSheetsOps, runDriveOps, formatResult } from "./google-ops.js";

const log = createLogger("google-mcp");
const PORT = parseInt(process.env.PORT || "3008", 10);

// ── OT evidence config ──────────────────────────────────────────────
// Loaded from /workspace/ot-evidence.json (mounted via docker volume).

interface Employee {
  no: number;
  employee_id: string;
  full_name_vn: string;
  email: string;
}

interface OtConfig {
  spreadsheet_id: string;
  drive_parent_folder_id: string;
  current_tab: string;
  employees: Employee[];
}

const OT_CONFIG_PATH = process.env.OT_CONFIG_PATH || "/workspace/ot-evidence.json";
let otConfig: OtConfig | undefined;

function getOtConfig(): OtConfig {
  if (!otConfig) {
    try {
      otConfig = JSON.parse(readFileSync(OT_CONFIG_PATH, "utf-8")) as OtConfig;
      logInfo(log, "ot_config_loaded", {
        spreadsheetId: otConfig.spreadsheet_id,
        employees: otConfig.employees.length,
      });
    } catch (err) {
      logError(log, "ot_config_missing", `Cannot load ${OT_CONFIG_PATH}: ${err}`);
      throw new Error(
        `OT config not found at ${OT_CONFIG_PATH}. Mount ot-evidence.json in the workspace volume.`,
      );
    }
  }
  return otConfig;
}

/** Resolve a Slack user's email to their Vietnamese name from the OT config. */
function resolveEmployee(email: string): Employee | undefined {
  const cfg = getOtConfig();
  return cfg.employees.find((e) => e.email.toLowerCase() === email.toLowerCase());
}

// ── Tool definitions ────────────────────────────────────────────────

const tools: Tool[] = [
  {
    name: "ot_read_sheet",
    description:
      "Read the OT evidence sheet and return a structured summary of all date groups and employees. Shows who has filled in evidence and who hasn't.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tab_name: {
          type: "string",
          description:
            "Sheet tab name (default: uses current_tab from config, usually 'Work Plan')",
        },
      },
    },
  },
  {
    name: "ot_find_employee_row",
    description:
      "Find an employee's row in the OT sheet for a specific date. Can look up by email or Vietnamese name. Returns the row number, current data, and A1 ranges for updating.",
    inputSchema: {
      type: "object" as const,
      properties: {
        email: {
          type: "string",
          description:
            "Employee email (e.g. 'phuc.truong@katalon.com'). Used to resolve Vietnamese name from config.",
        },
        employee_name: {
          type: "string",
          description:
            "Vietnamese full name as shown in the sheet (e.g. 'Trương Lê Vĩnh Phúc'). Use this OR email.",
        },
        ot_date: {
          type: "string",
          description:
            "OT date to find (e.g. '16/Apr/2026'). Flexible parsing — d/Mon/yyyy, dd/mm/yyyy, yyyy-mm-dd all work.",
        },
        tab_name: {
          type: "string",
          description: "Sheet tab name (default: from config)",
        },
      },
      required: ["ot_date"],
    },
  },
  {
    name: "ot_update_evidence",
    description:
      "Update an employee's OT evidence: their Ticket/Task description (column E) and optionally the Ref/Drive link (column F). Finds the row automatically by email + date. IMPORTANT: column F (Ref) may be pre-populated by HR with a Drive folder link — always read first and only overwrite if empty or you're adding a new link.",
    inputSchema: {
      type: "object" as const,
      properties: {
        email: {
          type: "string",
          description: "Employee email to identify the row",
        },
        employee_name: {
          type: "string",
          description: "Or: Vietnamese name directly",
        },
        ot_date: {
          type: "string",
          description: "OT date (e.g. '16/Apr/2026')",
        },
        ticket_task: {
          type: "string",
          description: "Content for column E — work description, ticket numbers, meetings, etc.",
        },
        ref: {
          type: "string",
          description:
            "Content for column F — Drive folder link for evidence screenshots. Only set if column F is currently empty.",
        },
        tab_name: {
          type: "string",
          description: "Sheet tab name (default: from config)",
        },
      },
      required: ["ot_date", "ticket_task"],
    },
  },
  {
    name: "ot_list_employees",
    description:
      "List all employees configured for OT evidence tracking. Returns employee IDs, Vietnamese names, and emails.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "drive_create_folder",
    description:
      "Create a folder in Google Drive under the OT evidence parent folder. Use for organizing per-employee per-date evidence screenshots.",
    inputSchema: {
      type: "object" as const,
      properties: {
        folder_name: {
          type: "string",
          description: "Folder name (e.g. 'Slowey - Evidence 16 Apr 2026')",
        },
        parent_folder_id: {
          type: "string",
          description:
            "Parent folder ID. Defaults to the OT evidence drive_parent_folder_id from config.",
        },
      },
      required: ["folder_name"],
    },
  },
  {
    name: "drive_upload_file",
    description:
      "Upload a local file to a Google Drive folder. Use for evidence files already saved to disk.",
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
      "Upload a file from base64-encoded content to Google Drive. Use for screenshots fetched from Slack via get_slack_file (which returns images as base64).",
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
    description:
      "List files in a Google Drive folder. Use to check what evidence has already been uploaded.",
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

const DEFAULT_TIMEOUT = 60_000;

async function handleToolCall(name: string, args: Record<string, unknown>) {
  const cfg = getOtConfig();

  switch (name) {
    // ── Sheets tools ──────────────────────────────────────────────

    case "ot_read_sheet": {
      const tab = String(args.tab_name || cfg.current_tab);
      return formatResult(
        await runSheetsOps([
          "--read-ot-summary",
          "--spreadsheet-id",
          cfg.spreadsheet_id,
          "--sheet-name",
          tab,
        ]),
      );
    }

    case "ot_find_employee_row": {
      const tab = String(args.tab_name || cfg.current_tab);
      const empName = resolveEmployeeName(args, cfg);
      return formatResult(
        await runSheetsOps([
          "--find-employee",
          "--spreadsheet-id",
          cfg.spreadsheet_id,
          "--sheet-name",
          tab,
          "--employee-name",
          empName,
          "--target-date",
          String(args.ot_date),
        ]),
      );
    }

    case "ot_update_evidence": {
      const tab = String(args.tab_name || cfg.current_tab);
      const empName = resolveEmployeeName(args, cfg);

      // Step 1: Find the row
      const findResult = await runSheetsOps([
        "--find-employee",
        "--spreadsheet-id",
        cfg.spreadsheet_id,
        "--sheet-name",
        tab,
        "--employee-name",
        empName,
        "--target-date",
        String(args.ot_date),
      ]);

      if (!findResult.ok) return formatResult(findResult);

      const found = JSON.parse(findResult.stdout);
      if (!found.found) {
        return {
          content: [{ type: "text" as const, text: findResult.stdout }],
          isError: true,
        };
      }

      // Step 2: Update the cells
      const ticketTask = String(args.ticket_task);
      const ref = args.ref ? String(args.ref) : undefined;

      if (ref) {
        // Update both E and F
        return formatResult(
          await runSheetsOps([
            "--update-range",
            "--spreadsheet-id",
            cfg.spreadsheet_id,
            "--range",
            found.range_ef,
            "--row",
            JSON.stringify([ticketTask, ref]),
          ]),
        );
      } else {
        // Update only E (Ticket/Task)
        return formatResult(
          await runSheetsOps([
            "--update-range",
            "--spreadsheet-id",
            cfg.spreadsheet_id,
            "--range",
            found.range_e,
            "--row",
            JSON.stringify([ticketTask]),
          ]),
        );
      }
    }

    case "ot_list_employees": {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              employees: cfg.employees,
              spreadsheet_id: cfg.spreadsheet_id,
              current_tab: cfg.current_tab,
            }),
          },
        ],
      };
    }

    // ── Drive tools ──────────────────────────────────────────────

    case "drive_create_folder": {
      const parentId = String(args.parent_folder_id || cfg.drive_parent_folder_id);
      return formatResult(
        await runDriveOps([
          "--create-folder",
          "--parent-id",
          parentId,
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
      // Pass base64 data via stdin to avoid argument-length limits
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
          120_000, // allow more time for large uploads
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

/** Resolve employee Vietnamese name from either email or direct name arg. */
function resolveEmployeeName(args: Record<string, unknown>, cfg: OtConfig): string {
  if (args.employee_name) return String(args.employee_name);
  if (args.email) {
    const emp = cfg.employees.find(
      (e) => e.email.toLowerCase() === String(args.email).toLowerCase(),
    );
    if (emp) return emp.full_name_vn;
    throw new Error(
      `No employee found for email '${args.email}'. Known emails: ${cfg.employees.map((e) => e.email).join(", ")}`,
    );
  }
  throw new Error("Either 'email' or 'employee_name' is required");
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
app.use(express.json({ limit: "50mb" })); // large payloads for base64 images

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
    otConfigPath: OT_CONFIG_PATH,
  });
});
