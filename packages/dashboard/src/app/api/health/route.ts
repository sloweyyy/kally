/**
 * GET /api/health — aggregated health from all internal services.
 *
 * Polls each service's /health endpoint from the server side (Next.js API
 * route runs inside Docker, so it can reach internal hostnames like
 * gateway:3002, runner:3000, etc.).
 */

import { NextResponse } from "next/server";

const SERVICES = [
  { name: "gateway", url: "http://gateway:3002/health" },
  { name: "runner", url: "http://runner:3000/health" },
  { name: "proxy", url: "http://proxy:3001/health" },
  { name: "vault", url: "http://vault:3006/health" },
  { name: "slack-mcp", url: "http://slack-mcp:3003/health" },
  { name: "salesforce-mcp", url: "http://salesforce-mcp:3005/health" },
  { name: "remote-cli", url: "http://remote-cli:3004/health" },
  { name: "opencode", url: "http://opencode:4096/global/health" },
];

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const results = await Promise.allSettled(
    SERVICES.map(async (s) => {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(3000), cache: "no-store" });
      const data = await res.json();
      return { name: s.name, ok: true, data };
    }),
  );

  const services = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      name: SERVICES[i].name,
      ok: false,
      error: r.reason?.message || "unreachable",
    };
  });

  return NextResponse.json({
    services,
    healthy: services.filter((s) => s.ok).length,
    total: SERVICES.length,
    ts: new Date().toISOString(),
  });
}
