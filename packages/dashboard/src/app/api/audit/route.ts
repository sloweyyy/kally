/**
 * GET /api/audit?n=50 — last N vault audit entries.
 */

import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";

const VAULT_AUDIT = process.env.VAULT_AUDIT_PATH || "/workspace/vault/audit.jsonl";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const n = Math.min(parseInt(url.searchParams.get("n") || "50", 10), 200);

  try {
    const raw = readFileSync(VAULT_AUDIT, "utf8").trim();
    if (!raw) return NextResponse.json([]);
    const lines = raw.split("\n").slice(-n);
    const entries = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return NextResponse.json(entries);
  } catch {
    return NextResponse.json([]);
  }
}
