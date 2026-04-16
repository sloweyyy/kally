/**
 * Kally Dashboard — lightweight real-time monitoring service.
 *
 * Runs inside the Docker Compose stack. Polls internal health endpoints,
 * tails the vault audit log, and streams updates to the browser via SSE.
 * No build step — mounts as a plain .mjs file on node:22-slim.
 *
 * Endpoints:
 *   GET /                  → dashboard HTML
 *   GET /api/health        → aggregated health from all services
 *   GET /api/audit         → last N vault audit entries
 *   GET /api/stats         → enrollment + uptime stats
 *   GET /api/stream        → SSE stream (health + audit events)
 */

import { createServer } from "node:http";
import { readFileSync, statSync, watchFile } from "node:fs";
import { join } from "node:path";

const PORT = parseInt(process.env.PORT || "3007", 10);
const VAULT_AUDIT = process.env.VAULT_AUDIT_PATH || "/workspace/vault/audit.jsonl";
const VAULT_FILE = process.env.VAULT_FILE_PATH || "/workspace/vault/kally.json";

// ── Internal services to poll ──────────────────────────────────────────

const SERVICES = [
  { name: "gateway",        url: "http://gateway:3002/health" },
  { name: "runner",         url: "http://runner:3000/health" },
  { name: "proxy",          url: "http://proxy:3001/health" },
  { name: "vault",          url: "http://vault:3006/health" },
  { name: "slack-mcp",      url: "http://slack-mcp:3003/health" },
  { name: "salesforce-mcp", url: "http://salesforce-mcp:3005/health" },
  { name: "remote-cli",     url: "http://remote-cli:3004/health" },
  { name: "opencode",       url: "http://opencode:4096/global/health" },
];

// ── Health polling ─────────────────────────────────────────────────────

let lastHealth = { services: [], healthy: 0, total: SERVICES.length, ts: null };

async function pollHealth() {
  const results = await Promise.allSettled(
    SERVICES.map(async (s) => {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      return { name: s.name, ok: true, data };
    })
  );
  const services = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return { name: SERVICES[i].name, ok: false, error: r.reason?.message || "unreachable" };
  });
  lastHealth = {
    services,
    healthy: services.filter((s) => s.ok).length,
    total: SERVICES.length,
    ts: new Date().toISOString(),
  };
  broadcast({ type: "health", data: lastHealth });
}

// ── Vault audit reading ────────────────────────────────────────────────

function readAuditTail(n = 50) {
  try {
    const raw = readFileSync(VAULT_AUDIT, "utf8").trim();
    if (!raw) return [];
    const lines = raw.split("\n").slice(-n);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readEnrolledUsers() {
  try {
    const data = JSON.parse(readFileSync(VAULT_FILE, "utf8"));
    const users = new Map();
    for (const [key, rec] of Object.entries(data.creds || {})) {
      const [uid, provider] = key.split(":");
      if (!users.has(uid)) users.set(uid, []);
      users.get(uid).push({ provider, created_at: rec.created_at, updated_at: rec.updated_at });
    }
    return { enrolled: users.size, total: 16, users: Object.fromEntries(users) };
  } catch { return { enrolled: 0, total: 16, users: {} }; }
}

// ── SSE ────────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// Watch audit file for changes and broadcast
let lastAuditSize = 0;
try { lastAuditSize = statSync(VAULT_AUDIT).size; } catch {}
watchFile(VAULT_AUDIT, { interval: 2000 }, (curr) => {
  if (curr.size > lastAuditSize) {
    lastAuditSize = curr.size;
    broadcast({ type: "audit", data: readAuditTail(5) });
  }
});

// ── HTTP server ────────────────────────────────────────────────────────

const htmlPath = join(import.meta.dirname, "index.html");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (url.pathname === "/" || url.pathname === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(htmlPath, "utf8"));
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastHealth));
    return;
  }

  if (url.pathname === "/api/audit") {
    const n = parseInt(url.searchParams.get("n") || "50", 10);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readAuditTail(n)));
    return;
  }

  if (url.pathname === "/api/stats") {
    const enrollment = readEnrolledUsers();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      enrollment,
      health: { healthy: lastHealth.healthy, total: lastHealth.total },
      upstreams: lastHealth.services.find(s => s.name === "proxy")?.data?.connected || 0,
      tracer: lastHealth.services.find(s => s.name === "runner")?.data?.opencode === "connected" ? "live" : "off",
    }));
    return;
  }

  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    // Send current state immediately
    res.write(`data: ${JSON.stringify({ type: "health", data: lastHealth })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "audit", data: readAuditTail(20) })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "stats", data: readEnrolledUsers() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// Poll health every 15s
setInterval(pollHealth, 15000);
pollHealth();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[dashboard] listening on :${PORT}`);
});
