import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { logError } from "@/lib/errorLog";
import { warmUpForCron } from "@/lib/cronPreflight";
import { runAutoResearch, AUTO_RESEARCH_RESERVE_MS } from "@/lib/ai";
import { runCronPerTenant } from "@/lib/tenantCron";

/**
 * Automatic research on new leads, once per tenant per tick.
 *
 * ITS OWN ROUTE, because of how long one call takes. On the ChatGPT
 * subscription a research call — GPT-6 Sol, high reasoning, around ten web
 * searches — measured 50 to 80 seconds. It used to be a phase of
 * /api/cron/automations, which is killed at 60 seconds, and the phases after it
 * were the campaign and survey queues: one new lead would have taken the whole
 * sending run down with it.
 *
 * 300 seconds is Vercel's ceiling. Each lead is only started with enough
 * budget left to finish it (AUTO_RESEARCH_RESERVE_MS), so a run that cannot
 * fit another lead stops cleanly and the next tick carries on — research is
 * once per lead, so nothing is repeated.
 *
 * Every 30 minutes, the same beat as the other frequent crons, so it adds no
 * database wake-ups of its own (tests/cronScheduleCost.test.ts).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MIN_START_BUDGET_MS = 15_000;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const routeBudget = await warmUpForCron("research", {
    routeBudgetMs: 290_000,
    minStartBudgetMs: MIN_START_BUDGET_MS,
  });
  if (!routeBudget.ok) {
    return NextResponse.json({ ok: false, skipped: routeBudget.reason }, { status: 503 });
  }

  const runs = await runCronPerTenant(
    async (_tenantId, budget) => {
      if (budget.shouldStop(AUTO_RESEARCH_RESERVE_MS)) return { researched: 0, skipped: "insufficient-budget" as const };
      return { researched: await runAutoResearch(budget) };
    },
    {
      maxRuntimeMs: routeBudget.remainingMs,
      minStartBudgetMs: MIN_START_BUDGET_MS,
      // One tenant at a time: a research call holds a function for over a
      // minute, and two in parallel would halve the leads each could fit.
      concurrency: 1,
      onError: (tenantId, error) =>
        logError("ai-auto-research", error, `tenant ${tenantId}`, { tenantId }),
    },
  );

  const failed = runs.filter((run) => run.status === "error").length;
  return NextResponse.json({ ok: failed === 0, runs }, { status: failed ? 207 : 200 });
}
