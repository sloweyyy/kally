/**
 * Kally OpenCode plugin — injects trusted env vars into every shell execution.
 *
 * Hooks into `shell.env` so that CLI wrappers (mcp, approval, git, gh) receive
 * THOR_OPENCODE_DIRECTORY and THOR_OPENCODE_SESSION_ID from OpenCode's own
 * context rather than trusting process.cwd() which the LLM can change via `cd`.
 *
 * Also injects the triggering user's identity (KALLY_USER_SLACK_ID,
 * KALLY_USER_EMAIL) when the runner has written it for this session. The
 * runner persists the identity to /workspace/memory/sessions/<sid>/user.json
 * before the prompt goes out, and both containers share that path. Reading
 * per-session from disk (rather than process env) is what makes multi-user
 * safe: each shell call resolves to whoever triggered THAT session, not to
 * whoever last restarted the opencode process.
 */

import { readFileSync, existsSync } from "node:fs";

const USER_FILE_BASE = "/workspace/memory/sessions";

export const KallyPlugin = async (plugin) => {
  return {
    "shell.env": async (hook, output) => {
      output.env.THOR_OPENCODE_DIRECTORY = plugin.directory;
      if (hook.sessionID) {
        output.env.THOR_OPENCODE_SESSION_ID = hook.sessionID;
        // Best-effort per-session user lookup. Failures stay silent — the
        // proxy logs missing identity itself, no need to scream from here.
        try {
          const userFile = `${USER_FILE_BASE}/${hook.sessionID}/user.json`;
          if (existsSync(userFile)) {
            const user = JSON.parse(readFileSync(userFile, "utf-8"));
            if (user.user_id) output.env.KALLY_USER_SLACK_ID = user.user_id;
            if (user.user_email) output.env.KALLY_USER_EMAIL = user.user_email;
          }
        } catch {
          // Malformed JSON, permission issue, race — ignore.
        }
      }
      if (hook.callID) {
        output.env.THOR_OPENCODE_CALL_ID = hook.callID;
      }
    },
  };
};
