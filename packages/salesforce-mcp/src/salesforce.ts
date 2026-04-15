import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// sf_ops.py lives at the package root (one level above dist/ and src/)
const SF_OPS_PATH = process.env.SF_OPS_PATH ?? path.resolve(__dirname, "..", "sf_ops.py");
const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";

export interface SfOpsResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Per-user Salesforce credentials injected by the proxy via `_kally_auth`.
 *  When passed to runSfOps, these OVERRIDE the container's env-based creds
 *  for the duration of the subprocess call. Undefined preserves today's
 *  env-based behaviour (Phase 2 / legacy). */
export interface SfRequestAuth {
  client_id?: string;
  client_secret?: string;
  username?: string;
  password?: string;
  instance_url?: string;
}

/** Run sf_ops.py with the given CLI args; capture stdout/stderr.
 *
 *  When `auth` is provided, it is spliced into the subprocess environment,
 *  overriding the corresponding SALESFORCE_* env vars. Anything missing
 *  from `auth` still falls back to process.env, so a partial override is
 *  fine. This is how per-user creds flow through without changing the
 *  sf_ops.py contract. */
export function runSfOps(
  args: string[],
  timeoutMs = 60_000,
  auth?: SfRequestAuth,
): Promise<SfOpsResult> {
  const env = { ...process.env };
  if (auth) {
    if (auth.client_id) env.SALESFORCE_CLIENT_ID = auth.client_id;
    if (auth.client_secret) env.SALESFORCE_CLIENT_SECRET = auth.client_secret;
    if (auth.username) env.SALESFORCE_USERNAME = auth.username;
    if (auth.password) env.SALESFORCE_PASSWORD = auth.password;
    if (auth.instance_url) env.SALESFORCE_INSTANCE_URL = auth.instance_url;
    // Disable the sf_ops token cache for per-user calls: the cache key is
    // the shared container session file, which would mix tokens across
    // different users. Setting KALLY_SF_NO_CACHE=1 tells sf_ops to skip it.
    env.KALLY_SF_NO_CACHE = "1";
  }
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, [SF_OPS_PATH, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const to = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
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

/** Format a result into MCP tool content (text only). */
export function formatResult(r: SfOpsResult): {
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
        text: `sf_ops.py exited ${r.exitCode}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
      },
    ],
    isError: true,
  };
}
