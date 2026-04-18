"use client";

import { useEffect, useState, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

/* ── Types ─────────────────────────────────────────────────────────── */

interface ServiceHealth {
  name: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

interface HealthData {
  services: ServiceHealth[];
  healthy: number;
  total: number;
  ts: string;
}

interface AuditEntry {
  ts: string;
  action: string;
  slack_uid: string;
  provider?: string;
  actor?: string;
  purpose?: string;
  ok: boolean;
}

interface StatsData {
  enrollment: {
    enrolled: number;
    total: number;
    users: Record<string, Array<{ provider: string; created_at: string; updated_at: string }>>;
  };
}

interface MetricsData {
  available: boolean;
  usage_per_user: Record<string, number>;
  cost_per_user: Record<string, number>;
  top_skills: Record<string, number>;
  top_tools: Array<[string, number]>;
  error_rate: number;
  total_runs: number;
  error_runs: number;
  avg_duration_sec: number;
  total_tool_calls: number;
  total_tokens: { input: number; output: number };
}

/* ── Skill colors from Cursor design system ────────────────────────── */
const SKILL_COLORS: Record<string, string> = {
  "task:runbook": "#dfa88f",
  "task:create-ksr": "#c0a8dd",
  "task:analyze-log": "#9fbbe0",
  "task:knowledge-consolidation": "#9fc9a2",
};
const DEFAULT_SKILL_COLOR = "#e1e0db";

const AUDIT_COLORS: Record<string, string> = {
  put: "#1f8a65",
  get: "#9fbbe0",
  delete: "#cf2d56",
  list: "#c08532",
};

/* ── Metric status helpers ─────────────────────────────────────────── */

type PillVariant = "green" | "orange" | "gold" | "red";

function Pill({ variant, children }: { variant: PillVariant; children: React.ReactNode }) {
  const colors: Record<PillVariant, string> = {
    green: "bg-[rgba(31,138,101,0.12)] text-[#1f8a65]",
    orange: "bg-[rgba(245,78,0,0.12)] text-[#f54e00]",
    gold: "bg-[rgba(192,133,50,0.12)] text-[#c08532]",
    red: "bg-[rgba(207,45,86,0.12)] text-[#cf2d56]",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[0.69rem] font-semibold ${colors[variant]}`}>
      {children}
    </span>
  );
}

/* ── Main page ─────────────────────────────────────────────────────── */

export default function Dashboard() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);

  const fetchAll = useCallback(async () => {
    const [h, s, a, m] = await Promise.allSettled([
      fetch("/api/health").then((r) => r.json()),
      fetch("/api/stats").then((r) => r.json()),
      fetch("/api/audit?n=30").then((r) => r.json()),
      fetch("/api/metrics").then((r) => r.json()),
    ]);
    if (h.status === "fulfilled") setHealth(h.value);
    if (s.status === "fulfilled") setStats(s.value);
    if (a.status === "fulfilled") setAudit(a.value);
    if (m.status === "fulfilled") setMetrics(m.value);
  }, []);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, 15000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  const enrolled = stats?.enrollment.enrolled ?? 0;
  const totalTeam = stats?.enrollment.total ?? 16;
  const healthy = health?.healthy ?? 0;
  const totalSvc = health?.total ?? 0;
  const upstreams =
    (health?.services.find((s) => s.name === "proxy")?.data as { connected?: number })?.connected ?? "?";
  const tracerOk =
    (health?.services.find((s) => s.name === "runner")?.data as { opencode?: string })?.opencode === "connected";

  /* ── Skill chart data ──────────────────────────────────────────── */
  const skillData = metrics?.available
    ? Object.entries(metrics.top_skills)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count }))
    : [
        { name: "task:runbook", count: 0 },
        { name: "task:create-ksr", count: 0 },
        { name: "task:analyze-log", count: 0 },
        { name: "task:knowledge-consolidation", count: 0 },
      ];

  /* ── Metrics table rows ────────────────────────────────────────── */
  const metricRows: Array<{
    id: string;
    name: string;
    target: string;
    variant: PillVariant;
    label: string;
  }> = [
    { id: "G1", name: "Adoption", target: `${totalTeam - 2}/${totalTeam} in 2 weeks`, variant: enrolled > totalTeam * 0.7 ? "green" : "orange", label: `${enrolled}/${totalTeam}` },
    { id: "G2", name: "Usage/user", target: "10+ triage/week", variant: metrics?.available ? "green" : "gold", label: metrics?.available ? `${metrics.total_runs} runs` : "pilot" },
    { id: "G3", name: "KSR time saved", target: "<3 min review", variant: "gold", label: "pilot" },
    { id: "G4", name: "Attribution", target: "100% per-user SF", variant: "green", label: "live" },
    { id: "G5", name: "Access gate", target: "0 non-support SF", variant: "green", label: "live" },
    { id: "G6", name: "LLM cost", target: "<$50/user/month", variant: metrics?.available ? "green" : "gold", label: metrics?.available ? `$${Object.values(metrics.cost_per_user).reduce((a, b) => a + b, 0).toFixed(2)}` : "pilot" },
    { id: "G7", name: "Top skills", target: "runbook+ksr >70%", variant: metrics?.available && Object.keys(metrics.top_skills).length > 0 ? "green" : "gold", label: metrics?.available ? `${Object.keys(metrics.top_skills).length} skills` : "pilot" },
    { id: "G8", name: "Tool error rate", target: "<5%/week", variant: metrics?.available ? (metrics.error_rate < 5 ? "green" : "red") : "gold", label: metrics?.available ? `${metrics.error_rate.toFixed(1)}%` : "pilot" },
    { id: "G9", name: "Queue/agent", target: "-20% in 4 weeks", variant: "orange", label: "baseline" },
    { id: "G10", name: "Stale Bug/FR", target: "0 >5d stale", variant: "orange", label: "baseline" },
  ];

  return (
    <div className="min-h-screen">
      {/* ── Nav ──────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-10 bg-[rgba(242,241,237,0.92)] backdrop-blur-xl border-b border-[var(--border)] px-6 py-3 flex items-center gap-3">
        <span className="text-lg font-semibold tracking-tight">Kally</span>
        <span className="text-[var(--text3)]">/</span>
        <span className="text-sm font-medium text-[var(--text2)]">Dashboard</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] animate-pulse" />
          <Pill variant={healthy === totalSvc ? "green" : healthy > 0 ? "orange" : "red"}>
            {healthy === totalSvc ? "all healthy" : `${healthy}/${totalSvc}`}
          </Pill>
          <span className="text-[0.63rem] text-[var(--text3)]">
            {health?.ts ? new Date(health.ts).toLocaleTimeString() : ""}
          </span>
        </div>
      </nav>

      <main className="max-w-[1200px] mx-auto px-6 py-10">
        {/* ── Hero ────────────────────────────────────────────────── */}
        <div className="mb-8">
          <h1 className="text-[2rem] font-normal tracking-tight leading-tight">Kally v1</h1>
          <p className="text-[var(--text2)] font-serif mt-1.5">
            Real-time monitoring. Per-user credentials, support-only gate, 4 skills live.
          </p>
        </div>

        {/* ── KPIs ───────────────────────────────────────────────── */}
        <div className="grid grid-cols-4 gap-3.5 mb-8 max-md:grid-cols-2">
          {[
            { label: "Enrolled", value: `${enrolled}`, sub: `of ${totalTeam} support` },
            { label: "Services", value: `${healthy}/${totalSvc}`, sub: "healthy" },
            { label: "Upstreams", value: `${upstreams}`, sub: "MCP connected" },
            { label: "Tracing", value: tracerOk ? "live" : "off", sub: "LangSmith" },
          ].map((kpi) => (
            <div key={kpi.label} className="bg-[var(--s400)] border border-[var(--border)] rounded-[10px] p-5 hover:shadow-[rgba(0,0,0,0.02)_0_0_16px]">
              <div className="text-[0.69rem] font-semibold text-[var(--text2)] uppercase tracking-wider">{kpi.label}</div>
              <div className="text-[2rem] font-normal tracking-tight leading-none mt-1.5 mb-0.5">{kpi.value}</div>
              <div className="text-[0.63rem] text-[var(--text3)]">{kpi.sub}</div>
            </div>
          ))}
        </div>

        {/* ── LangSmith KPIs ──────────────────────────────────────── */}
        {metrics?.available && (
          <div className="grid grid-cols-4 gap-3.5 mb-8 max-md:grid-cols-2">
            {[
              { label: "Sessions (7d)", value: `${metrics.total_runs}`, sub: `${metrics.error_runs} errors (${metrics.error_rate.toFixed(1)}%)` },
              { label: "Avg duration", value: `${metrics.avg_duration_sec}s`, sub: "per session" },
              { label: "Tool calls", value: `${metrics.total_tool_calls}`, sub: `across ${metrics.total_runs} sessions` },
              { label: "Tokens (7d)", value: metrics.total_tokens.input + metrics.total_tokens.output > 0 ? `${Math.round((metrics.total_tokens.input + metrics.total_tokens.output) / 1000)}k` : "n/a", sub: metrics.total_tokens.input > 0 ? `${Math.round(metrics.total_tokens.input/1000)}k in / ${Math.round(metrics.total_tokens.output/1000)}k out` : "ChatGPT Plus: no token reporting" },
            ].map((kpi) => (
              <div key={kpi.label} className="bg-[var(--s100)] border border-[var(--border)] rounded-[10px] p-5 hover:shadow-[rgba(0,0,0,0.02)_0_0_16px]">
                <div className="text-[0.69rem] font-semibold text-[var(--text2)] uppercase tracking-wider">{kpi.label}</div>
                <div className="text-[2rem] font-normal tracking-tight leading-none mt-1.5 mb-0.5">{kpi.value}</div>
                <div className="text-[0.63rem] text-[var(--text3)]">{kpi.sub}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Top tools chart ─────────────────────────────────────── */}
        {metrics?.available && metrics.top_tools.length > 0 && (
          <section className="mb-9">
            <h2 className="text-[1.25rem] font-normal tracking-tight mb-3">Top tools (7d)</h2>
            <div className="bg-[var(--s400)] border border-[var(--border)] rounded-[10px] p-5">
              <ResponsiveContainer width="100%" height={Math.max(180, metrics.top_tools.length * 32)}>
                <BarChart data={metrics.top_tools.map(([name, count]) => ({ name, count }))} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <XAxis type="number" tick={{ fontSize: 11, fill: "var(--text2)" }} />
                  <YAxis type="category" dataKey="name" width={180} tick={{ fontSize: 11, fill: "var(--text2)" }} />
                  <Tooltip contentStyle={{ background: "var(--s100)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} fill="#9fbbe0" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        )}

        {/* ── Usage per user ──────────────────────────────────────── */}
        {metrics?.available && Object.keys(metrics.usage_per_user).length > 0 && (
          <section className="mb-9">
            <h2 className="text-[1.25rem] font-normal tracking-tight mb-3">G2 Usage per user (7d)</h2>
            <div className="bg-[var(--s400)] border border-[var(--border)] rounded-[10px] p-5">
              <ResponsiveContainer width="100%" height={Math.max(120, Object.keys(metrics.usage_per_user).length * 40)}>
                <BarChart data={Object.entries(metrics.usage_per_user).sort((a,b) => b[1]-a[1]).map(([name, count]) => ({ name: name.replace("@katalon.com",""), count }))} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <XAxis type="number" tick={{ fontSize: 11, fill: "var(--text2)" }} />
                  <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 11, fill: "var(--text2)" }} />
                  <Tooltip contentStyle={{ background: "var(--s100)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} fill="#dfa88f" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        )}

        {/* ── Services ───────────────────────────────────────────── */}
        <section className="mb-9">
          <h2 className="text-[1.25rem] font-normal tracking-tight mb-3">Services</h2>
          <div className="grid grid-cols-4 gap-2 max-md:grid-cols-2">
            {health?.services.map((s) => (
              <div key={s.name} className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-[var(--s300)] border border-[var(--border)] text-[0.75rem] font-medium">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.ok ? "bg-[var(--success)]" : "bg-[var(--error)]"}`} />
                <span className="flex-1">{s.name}</span>
                <span className="text-[0.63rem] text-[var(--text3)]">
                  {s.ok
                    ? (() => {
                        const data = (s.data ?? {}) as Record<string, unknown>;
                        if (typeof data.tools === "number") return `${data.tools} tools`;
                        if (typeof data.connected === "number") return `${data.connected} upstreams`;
                        if (typeof data.opencode === "string") return data.opencode;
                        return "ok";
                      })()
                    : "down"}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Two columns: skills chart + metrics ────────────────── */}
        <div className="grid grid-cols-2 gap-3.5 mb-9 max-md:grid-cols-1">
          {/* Skills chart */}
          <section>
            <h2 className="text-[1.25rem] font-normal tracking-tight mb-3">G7 Top skills (7d)</h2>
            <div className="bg-[var(--s400)] border border-[var(--border)] rounded-[10px] p-5">
              {skillData.length > 0 && skillData.some((d) => d.count > 0) ? (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={skillData} layout="vertical" margin={{ left: 10, right: 20 }}>
                    <XAxis type="number" tick={{ fontSize: 11, fill: "var(--text2)" }} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={160}
                      tick={{ fontSize: 11, fill: "var(--text2)" }}
                      tickFormatter={(v: string) => v.replace("task:", "")}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--s100)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                      {skillData.map((entry) => (
                        <Cell key={entry.name} fill={SKILL_COLORS[entry.name] || DEFAULT_SKILL_COLOR} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-[0.81rem] text-[var(--text3)] italic py-8 text-center">
                  {metrics?.available ? "No skill data in the last 7 days" : "Connect LangSmith to see skill usage"}
                </div>
              )}
            </div>
          </section>

          {/* Metrics table */}
          <section>
            <h2 className="text-[1.25rem] font-normal tracking-tight mb-3">Metrics targets</h2>
            <div className="bg-[var(--s400)] border border-[var(--border)] rounded-[10px] p-5 overflow-x-auto">
              <table className="w-full text-[0.75rem]">
                <thead>
                  <tr className="border-b border-[var(--border-m)]">
                    <th className="text-left pb-2 text-[0.63rem] font-semibold text-[var(--text2)] uppercase tracking-wider">#</th>
                    <th className="text-left pb-2 text-[0.63rem] font-semibold text-[var(--text2)] uppercase tracking-wider">Metric</th>
                    <th className="text-left pb-2 text-[0.63rem] font-semibold text-[var(--text2)] uppercase tracking-wider">Target</th>
                    <th className="text-left pb-2 text-[0.63rem] font-semibold text-[var(--text2)] uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {metricRows.map((row) => (
                    <tr key={row.id} className="border-b border-[var(--border)] last:border-b-0">
                      <td className="py-2 font-medium">{row.id}</td>
                      <td className="py-2">{row.name}</td>
                      <td className="py-2 text-[var(--text2)]">{row.target}</td>
                      <td className="py-2"><Pill variant={row.variant}>{row.label}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* ── Two columns: audit + enrolled ───────────────────────── */}
        <div className="grid grid-cols-2 gap-3.5 mb-9 max-md:grid-cols-1">
          {/* Audit log */}
          <section>
            <h2 className="text-[1.25rem] font-normal tracking-tight mb-3">Vault audit (live)</h2>
            <div className="bg-[var(--s100)] border border-[var(--border)] rounded-[10px] p-4 max-h-[400px] overflow-y-auto">
              {audit.length > 0 ? (
                <ul className="space-y-0">
                  {[...audit].reverse().map((e, i) => (
                    <li key={i} className="flex gap-2.5 py-2 border-b border-[var(--border)] last:border-b-0 items-start">
                      <span
                        className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                        style={{ background: AUDIT_COLORS[e.action] || "var(--text3)" }}
                      />
                      <div>
                        <div className="text-[0.75rem] font-medium">
                          {e.action === "put" ? "enrolled" : e.action === "delete" ? "revoked" : e.action === "get" ? "cred read" : e.action}{" "}
                          {e.provider || ""}{e.purpose ? ` for ${e.purpose}` : ""}
                        </div>
                        <div className="text-[0.63rem] text-[var(--text3)]">
                          {e.slack_uid} {e.actor ? `via ${e.actor}` : ""} {e.ts ? new Date(e.ts).toLocaleTimeString() : ""}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-[0.81rem] text-[var(--text3)] italic py-4 text-center">No audit entries yet</div>
              )}
            </div>
          </section>

          {/* Enrolled users */}
          <section>
            <h2 className="text-[1.25rem] font-normal tracking-tight mb-3">Enrolled users</h2>
            <div className="bg-[var(--s100)] border border-[var(--border)] rounded-[10px] p-4">
              {stats && Object.keys(stats.enrollment.users).length > 0 ? (
                <table className="w-full text-[0.75rem]">
                  <thead>
                    <tr className="border-b border-[var(--border-m)]">
                      <th className="text-left pb-2 text-[0.63rem] font-semibold text-[var(--text2)] uppercase tracking-wider">User</th>
                      <th className="text-left pb-2 text-[0.63rem] font-semibold text-[var(--text2)] uppercase tracking-wider">Providers</th>
                      <th className="text-left pb-2 text-[0.63rem] font-semibold text-[var(--text2)] uppercase tracking-wider">Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(stats.enrollment.users).map(([uid, providers]) => (
                      <tr key={uid} className="border-b border-[var(--border)] last:border-b-0">
                        <td className="py-2 font-mono text-[0.69rem]">{uid}</td>
                        <td className="py-2">
                          {providers.map((p) => (
                            <Pill key={p.provider} variant="green">{p.provider}</Pill>
                          ))}
                        </td>
                        <td className="py-2 text-[0.63rem] text-[var(--text3)]">
                          {new Date(providers[0].created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-[0.81rem] text-[var(--text3)] italic py-4 text-center">No users enrolled yet</div>
              )}
            </div>
          </section>
        </div>

        {/* ── Access policies ────────────────────────────────────── */}
        <section className="mb-9">
          <h2 className="text-[1.25rem] font-normal tracking-tight mb-3">Access policies</h2>
          <div className="grid grid-cols-3 gap-3.5 max-md:grid-cols-1">
            {[
              { name: "Salesforce", policy: "support", color: "var(--success)", desc: `${totalTeam} emails. per_user_creds: args mode.` },
              { name: "Atlassian", policy: "katalon", color: "var(--read)", desc: "Any @katalon.com. per_user_creds: connection mode." },
              { name: "Slack", policy: "public", color: "var(--text3)", desc: "Any channel Kally is invited to." },
            ].map((p) => (
              <div key={p.name} className="bg-[var(--s400)] border border-[var(--border)] rounded-[10px] p-5" style={{ borderLeftWidth: 3, borderLeftColor: p.color }}>
                <div className="text-[0.69rem] font-semibold text-[var(--text2)] uppercase tracking-wider">{p.name}</div>
                <div className="text-[1.1rem] tracking-tight mt-1 mb-1">{p.policy}</div>
                <div className="text-[0.69rem] text-[var(--text2)]">{p.desc}</div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Quick links ────────────────────────────────────────── */}
        <section className="mb-9">
          <h2 className="text-[1.25rem] font-normal tracking-tight mb-3">Quick links</h2>
          <div className="grid grid-cols-4 gap-3.5 max-md:grid-cols-2">
            {[
              { label: "Traces", title: "LangSmith", sub: "project: kally", href: "https://smith.langchain.com" },
              { label: "Docs", title: "Confluence", sub: "PRD + Architecture", href: "https://katalon.atlassian.net/wiki/spaces/CST/pages/5271584787/Kally" },
              { label: "Product", title: "PRD v1", sub: "goals + rollout", href: "https://katalon.atlassian.net/wiki/spaces/CST/pages/5271060497" },
              { label: "Onboarding", title: "User Guide", sub: "for teammates", href: "https://katalon.atlassian.net/wiki/spaces/CST/pages/5271093257" },
            ].map((link) => (
              <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer"
                className="bg-[var(--s400)] border border-[var(--border)] rounded-[10px] p-5 no-underline text-[var(--cursor-dark)] hover:shadow-[rgba(0,0,0,0.02)_0_0_16px] transition-shadow">
                <div className="text-[0.69rem] font-semibold text-[var(--text2)] uppercase tracking-wider">{link.label}</div>
                <div className="text-[0.88rem] font-medium mt-1">{link.title}</div>
                <div className="text-[0.63rem] text-[var(--text3)] mt-0.5">{link.sub}</div>
              </a>
            ))}
          </div>
        </section>
      </main>

      <footer className="text-center py-6 text-[0.69rem] text-[var(--text3)] border-t border-[var(--border)]">
        Kally v1 — Product Support AI Teammate — April 2026 — model: openai/gpt-5.4
      </footer>
    </div>
  );
}
