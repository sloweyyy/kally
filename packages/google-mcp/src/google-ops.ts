import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";
const DRIVE_OPS_PATH = process.env.DRIVE_OPS_PATH ?? path.resolve(__dirname, "..", "drive_ops.py");

export interface OpsResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runScript(
  scriptPath: string,
  args: string[],
  timeoutMs: number,
  stdin?: string,
): Promise<OpsResult> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, [scriptPath, ...args], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const to = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));

    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    child.on("close", (code) => {
      clearTimeout(to);
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });
    child.on("error", (err) => {
      clearTimeout(to);
      resolve({ ok: false, stdout, stderr: stderr + String(err), exitCode: null });
    });
  });
}

export function runDriveOps(
  args: string[],
  timeoutMs = 60_000,
  stdin?: string,
): Promise<OpsResult> {
  return runScript(DRIVE_OPS_PATH, args, timeoutMs, stdin);
}

export function formatResult(r: OpsResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  if (r.ok) {
    return { content: [{ type: "text", text: r.stdout || "(empty)" }] };
  }
  return {
    content: [
      {
        type: "text",
        text: `script exited ${r.exitCode}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
      },
    ],
    isError: true,
  };
}
