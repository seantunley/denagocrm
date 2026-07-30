import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { logError } from "@/lib/errorLog";
import { warmUpForCron } from "@/lib/cronPreflight";
import { runJourneyEngine } from "@/lib/journeys";
import { runCronPerTenant } from "@/lib/tenantCron";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Wake a suspended endpoint first; the sweep itself sends messages and runs
  // exactly once. Waking costs real wall-clock, so it comes out of the same
  // budget rather than being added on top of it. See lib/dbRetry.ts.
  const MIN_START_BUDGET_MS = 8_000;
  const budget = await warmUpForCron("journeys", {
    routeBudgetMs: 50_000,
    minStartBudgetMs: MIN_START_BUDGET_MS,
  });
  if (!budget.ok) {
    return NextResponse.json({ ok: false, skipped: budget.reason }, { status: 503 });
  }

  try {
    // Journeys are a per-tenant business queue. The helper rotates the starting
    // tenant, bounds concurrency, stops admitting work at the route deadline, and
    // records one tenant's failure without starving every tenant behind it.
    const runs = await runCronPerTenant(async () => {
      if (!(await getEnabledModuleIds()).has("marketing")) {
        return { skipped: "marketing-disabled" as const };
      }
      return runJourneyEngine();
    }, {
      maxRuntimeMs: budget.remainingMs,
      minStartBudgetMs: MIN_START_BUDGET_MS,
      concurrency: 2,
      rotationWindowMs: 15 * 60 * 1000,
      onError: (tenantId, error) => logError(`journey-engine:${tenantId}`, error),
    });
    const dormant = runs.length === 1 && runs[0].tenantId === null ? runs[0] : null;
    if (dormant?.status === "ok") {
      return NextResponse.json({ ok: true, ...dormant.result });
    }
    return NextResponse.json({ ok: true, tenants: runs });
  } catch (error) {
    await logError("journey-engine", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Journey processing failed" },
      { status: 500 }
    );
  }
}
