import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { logError } from "@/lib/errorLog";
import { warmUpForCron } from "@/lib/cronPreflight";
import { runJourneyEngine } from "@/lib/journeys";
import { runCronPerTenant } from "@/lib/tenantCron";

export const maxDuration = 60;

/**
 * Budget the journey engine needs in hand before it is allowed to start. It
 * sends email and WhatsApp and has no internal stop point, so admitting it with
 * seconds left is how a send gets cut in half.
 */
const JOURNEY_RESERVE_MS = 10_000;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Wake a suspended endpoint first; the sweep itself sends messages and runs
  // exactly once. Waking costs real wall-clock, so it comes out of the same
  // budget rather than being added on top of it. See lib/dbRetry.ts.
  const MIN_START_BUDGET_MS = 8_000;
  const routeBudget = await warmUpForCron("journeys", {
    routeBudgetMs: 50_000,
    minStartBudgetMs: MIN_START_BUDGET_MS,
  });
  if (!routeBudget.ok) {
    return NextResponse.json({ ok: false, skipped: routeBudget.reason }, { status: 503 });
  }

  try {
    // Journeys are a per-tenant business queue. The helper rotates the starting
    // tenant, bounds concurrency, stops admitting work at the route deadline, and
    // records one tenant's failure without starving every tenant behind it.
    const runs = await runCronPerTenant(async (_tenantId, budget) => {
      if (!(await getEnabledModuleIds()).has("marketing")) {
        return { skipped: "marketing-disabled" as const };
      }
      // Decline outright when there is not even time for one unit of work…
      if (budget.shouldStop(JOURNEY_RESERVE_MS)) {
        return { skipped: "insufficient-budget" as const };
      }
      // …and hand the deadline DOWN, so the engine stops between records,
      // events, runs and steps rather than running to completion regardless of
      // the clock. A fixed admission reserve cannot bound work that can span
      // 1000 records, 50 events and 40 runs of up to 20 steps.
      return runJourneyEngine(budget);
    }, {
      maxRuntimeMs: routeBudget.remainingMs,
      minStartBudgetMs: MIN_START_BUDGET_MS,
      concurrency: 2,
      rotationWindowMs: 15 * 60 * 1000,
      // Attribute to the failing tenant: `onError` runs outside its scope, so this is
      // the only point at which the owner of the failure is still known.
      onError: (tenantId, error) => logError(`journey-engine:${tenantId}`, error, undefined, { tenantId }),
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
