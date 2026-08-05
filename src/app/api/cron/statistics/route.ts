import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { logError } from "@/lib/errorLog";
import { warmUpForCron } from "@/lib/cronPreflight";
import { rollUpStatistics } from "@/lib/statistics";
import { runCronPerTenant } from "@/lib/tenantCron";

export const maxDuration = 60;

/**
 * Roll up reporting statistics, once per tenant per tick.
 *
 * ITS OWN ROUTE, not another phase bolted onto /api/cron/automations. That
 * route's phases all SEND things — email, WhatsApp, pushes — and it stops
 * admitting them near its deadline so a send is never cut in half. Reporting
 * housekeeping sharing that budget would be competing with delivery for it, and
 * losing that competition is the correct outcome every time, which is another
 * way of saying it would rarely run. Separate routes let the rollup have a
 * budget nothing else wants.
 *
 * Not gated on a module either: the Reports page is core, not marketing.
 */
const ROLLUP_RESERVE_MS = 5_000;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Wake a suspended database endpoint first, out of the same budget rather than
  // on top of it — see lib/dbRetry.ts. The rollup is idempotent, so unlike the
  // sending queues it would survive being run twice; the preflight is still
  // worth it because a cold start would otherwise eat the whole tick.
  const MIN_START_BUDGET_MS = 6_000;
  const routeBudget = await warmUpForCron("statistics", {
    routeBudgetMs: 50_000,
    minStartBudgetMs: MIN_START_BUDGET_MS,
  });
  if (!routeBudget.ok) {
    return NextResponse.json({ ok: false, skipped: routeBudget.reason }, { status: 503 });
  }

  try {
    const runs = await runCronPerTenant(async (_tenantId, budget) => {
      // A tenant admitted with seconds left would start a backfill it cannot
      // finish. Nothing is lost by declining — the rollup is incremental, so
      // the next tick resumes from the same cursor rather than restarting.
      if (budget.shouldStop(ROLLUP_RESERVE_MS)) return { skipped: "insufficient-budget" as const };
      return rollUpStatistics();
    }, {
      maxRuntimeMs: routeBudget.remainingMs,
      minStartBudgetMs: MIN_START_BUDGET_MS,
      concurrency: 2,
      rotationWindowMs: 15 * 60 * 1000,
      onError: (tenantId, error) => logError(`statistics-rollup:${tenantId}`, error),
    });
    const dormant = runs.length === 1 && runs[0].tenantId === null ? runs[0] : null;
    if (dormant?.status === "ok") return NextResponse.json({ ok: true, ...dormant.result });
    return NextResponse.json({ ok: true, tenants: runs });
  } catch (error) {
    await logError("statistics-rollup", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Statistics rollup failed" },
      { status: 500 },
    );
  }
}
