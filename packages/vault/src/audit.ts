/**
 * Append-only audit log for vault accesses.
 *
 * One line per `(get|put|delete|list)`. Never includes the plaintext secret.
 * The log lives alongside the vault file and is owned by the vault container
 * only. Shipping it to a SIEM or Grafana Loki is a follow-up.
 *
 * Structure:
 *   { ts, action, slack_uid, provider?, actor?, purpose?, ok, error? }
 *
 *   - `actor`: the service/user that called the vault (e.g. "gateway",
 *     "proxy", "admin") — proxy will set this header once it's cred-aware
 *     in Phase 3.
 *   - `purpose`: optional free-text reason, carried via `x-kally-call-purpose`
 *     header. Great for "investigate why vault was read at 3am" questions.
 *   - `ok`: boolean — successful get/put/delete vs. 404/error.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditLine {
  ts: string;
  action: "get" | "put" | "delete" | "list";
  slack_uid: string;
  provider?: string;
  actor?: string;
  purpose?: string;
  ok: boolean;
  error?: string;
}

export class AuditLog {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  write(line: AuditLine): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch {
      // Audit write failures are non-fatal but worth stderr-ing. Never throw
      // from audit into the request path — a broken disk shouldn't take the
      // whole vault down.
      // eslint-disable-next-line no-console
      process.stderr.write(`vault_audit_write_failed path=${this.filePath} ts=${line.ts}\n`);
    }
  }
}
