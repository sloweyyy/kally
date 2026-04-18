/**
 * GET /api/metrics — aggregated metrics from LangSmith.
 *
 * Queries the LangSmith REST API for trace-level data:
 * - G2: usage count per user (traces per user_id per week)
 * - G6: cost per user (sum total_cost per user_id)
 * - G7: top skills (count by run name matching task:*)
 * - G8: tool error rate (error runs / total runs)
 *
 * Returns empty/zero values when LANGSMITH_API_KEY is not set.
 */

import { NextResponse } from "next/server";
import { Client } from "langsmith";

export const dynamic = "force-dynamic";

const LANGSMITH_API_KEY = process.env.LANGSMITH_API_KEY;
const LANGSMITH_PROJECT = process.env.LANGSMITH_PROJECT || "kally";

export async function GET() {
  if (!LANGSMITH_API_KEY) {
    return NextResponse.json({
      available: false,
      reason: "LANGSMITH_API_KEY not set",
      usage_per_user: {},
      cost_per_user: {},
      top_skills: {},
      error_rate: 0,
      total_runs: 0,
      error_runs: 0,
    });
  }

  try {
    const client = new Client({
      apiKey: LANGSMITH_API_KEY,
      apiUrl: process.env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com",
    });

    // Get runs from the last 7 days
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const usagePerUser: Record<string, number> = {};
    const costPerUser: Record<string, number> = {};
    const skills: Record<string, number> = {};
    const toolCounts: Record<string, number> = {};
    let totalRuns = 0;
    let errorRuns = 0;
    let totalDurationMs = 0;
    let totalToolCalls = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    // List root runs (traces) for the project
    for await (const run of client.listRuns({
      projectName: LANGSMITH_PROJECT,
      startTime: since,
      isRoot: true,
    })) {
      totalRuns++;
      if (run.status === "error") errorRuns++;

      // Duration
      if (run.end_time && run.start_time) {
        totalDurationMs += new Date(run.end_time).getTime() - new Date(run.start_time).getTime();
      }

      // Tokens from output (if available in extra)
      const outputs = run.outputs as Record<string, unknown> | undefined;
      const tokens = outputs?.tokens as Record<string, number> | undefined;
      if (tokens) {
        totalTokensIn += tokens.input || 0;
        totalTokensOut += tokens.output || 0;
      }

      // Extract user_id from metadata
      const meta = run.extra?.metadata as Record<string, unknown> | undefined;
      const userId = meta?.user_id as string | undefined;
      const userEmail = meta?.user_email as string | undefined;
      const displayUser = userEmail || userId || "unknown";
      if (displayUser !== "unknown") {
        usagePerUser[displayUser] = (usagePerUser[displayUser] || 0) + 1;
        const runCost = (run as unknown as { total_cost?: number }).total_cost;
        if (typeof runCost === "number") {
          costPerUser[displayUser] = (costPerUser[displayUser] || 0) + runCost;
        }
      }

      // Count tool calls from outputs
      const toolCallList = outputs?.tool_calls as Array<{ tool: string }> | undefined;
      if (toolCallList) {
        totalToolCalls += toolCallList.length;
        for (const tc of toolCallList) {
          const name = tc.tool || "unknown";
          toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
      }
    }

    // List child runs to find skill dispatches (task:*)
    for await (const run of client.listRuns({
      projectName: LANGSMITH_PROJECT,
      startTime: since,
      runType: "chain",
      isRoot: false,
    })) {
      if (run.name?.startsWith("task:")) {
        // Clean up the name: "task:ses_26d9" → "unnamed"
        // "task:runbook" → "runbook"
        let skillName = run.name.replace("task:", "");
        if (skillName.startsWith("ses_") || skillName.match(/^[a-f0-9]{8}$/)) {
          skillName = "unnamed";
        }
        skills[skillName] = (skills[skillName] || 0) + 1;
      }
    }

    const avgDurationSec = totalRuns > 0 ? Math.round(totalDurationMs / totalRuns / 1000) : 0;

    return NextResponse.json({
      available: true,
      period: "7d",
      since: since.toISOString(),
      usage_per_user: usagePerUser,
      cost_per_user: costPerUser,
      top_skills: skills,
      top_tools: Object.entries(toolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
      error_rate: totalRuns > 0 ? (errorRuns / totalRuns) * 100 : 0,
      total_runs: totalRuns,
      error_runs: errorRuns,
      avg_duration_sec: avgDurationSec,
      total_tool_calls: totalToolCalls,
      total_tokens: { input: totalTokensIn, output: totalTokensOut },
    });
  } catch (err) {
    return NextResponse.json(
      {
        available: false,
        reason: String(err),
        usage_per_user: {},
        cost_per_user: {},
        top_skills: {},
        error_rate: 0,
        total_runs: 0,
        error_runs: 0,
      },
      { status: 200 },
    );
  }
}
