import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { logError } from "@/lib/errorLog";
import { warmUpForCron } from "@/lib/cronPreflight";
import { runCronPerTenant } from "@/lib/tenantCron";
import { sweepOrphanPhotos } from "@/lib/photoOrphans";

export const maxDuration = 60;

/**
 * Delete staged photos that never became records.
 *
 * Direct uploads put the file in the store BEFORE the action that files it runs.
 * A phone that loses signal, locks, or has its PWA closed between the two leaves
 * an object nothing points at — invisible in the app, undeletable through it, and
 * billed. See lib/photoOrphans.ts for why this is a background job rather than a
 * catch block.
 *
 * Its own route rather than a phase on another: this walks the whole upload
 * namespace and issues deletes, so sharing a budget with the sending queues would
 * mean it either starved them or was starved by them. Starving is the correct
 * outcome for housekeeping every single tick, which is another way of saying it
 * would never run.
 */
const SWEEP_RESERVE_MS = 5_000;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const MIN_START_BUDGET_MS = 6_000;
  const routeBudget = await warmUpForCron("photo-orphans", {
    routeBudgetMs: 50_000,
    minStartBudgetMs: MIN_START_BUDGET_MS,
  });
  if (!routeBudget.ok) {
    return NextResponse.json({ ok: false, skipped: routeBudget.reason }, { status: 503 });
  }

  try {
    const runs = await runCronPerTenant(async (tenantId, budget) => {
      if (budget.shouldStop(SWEEP_RESERVE_MS)) return { skipped: "insufficient-budget" as const };
      return sweepOrphanPhotos({
        // The slice's tenant, passed in rather than re-derived — the sweep issues
        // DELETES, so it must never widen past the workspace it was called for.
        tenantId,
        // Stop on a whole object rather than being cut off mid-delete; the sweep
        // is idempotent, so the next tick simply carries on.
        shouldStop: () => budget.shouldStop(SWEEP_RESERVE_MS),
      });
    }, {
      maxRuntimeMs: routeBudget.remainingMs,
      minStartBudgetMs: MIN_START_BUDGET_MS,
      concurrency: 1,
      rotationWindowMs: 60 * 60 * 1000,
      onError: (tenantId, error) => logError(`photo-orphan-sweep:${tenantId}`, error, undefined, { tenantId }),
    });
    const dormant = runs.length === 1 && runs[0].tenantId === null ? runs[0] : null;
    if (dormant?.status === "ok") return NextResponse.json({ ok: true, ...dormant.result });
    return NextResponse.json({ ok: true, tenants: runs.length });
  } catch (error) {
    await logError("photo-orphan-sweep", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
