/**
 * GET /api/stats — enrollment + system stats.
 *
 * Reads the vault JSON file directly (mounted read-only) to count
 * enrolled users and their providers. No vault API call needed.
 */

import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";

const VAULT_FILE = process.env.VAULT_FILE_PATH || "/workspace/vault/kally.json";
const CONFIG_FILE = process.env.CONFIG_FILE_PATH || "/workspace/config.json";

function getSupportTeamSize(): number {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const config = JSON.parse(raw) as { support_team_emails?: string[] };
    return config.support_team_emails?.length ?? 0;
  } catch {
    return 0;
  }
}

export const dynamic = "force-dynamic";

interface VaultRecord {
  created_at: string;
  updated_at: string;
}

export async function GET() {
  try {
    const raw = readFileSync(VAULT_FILE, "utf8");
    const data = JSON.parse(raw) as { creds: Record<string, VaultRecord> };

    const users = new Map<
      string,
      Array<{ provider: string; created_at: string; updated_at: string }>
    >();
    for (const [key, rec] of Object.entries(data.creds || {})) {
      const [uid, provider] = key.split(":");
      if (!users.has(uid)) users.set(uid, []);
      users.get(uid)!.push({
        provider,
        created_at: rec.created_at,
        updated_at: rec.updated_at,
      });
    }

    const teamSize = getSupportTeamSize();
    return NextResponse.json({
      enrollment: {
        enrolled: users.size,
        total: teamSize,
        users: Object.fromEntries(users),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { enrollment: { enrolled: 0, total: getSupportTeamSize(), users: {} }, error: String(err) },
      { status: 200 },
    );
  }
}
