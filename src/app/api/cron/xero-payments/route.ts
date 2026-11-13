import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { logError } from "@/lib/errorLog";
import { warmUpForCron } from "@/lib/cronPreflight";
import { runCronPerTenant } from "@/lib/tenantCron";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { runAutomaticXeroCheck } from "@/lib/xeroSync";

export const maxDuration = 60;

/**
 * The daily automatic Xero payments check (Sean, 2026-11-11: "An automatic
 * background check of Xero for payments. Today it happens when someone presses
 * Refresh"; 2026-11-13: "once a day, not once an hour" — vercel.json, 06:40 SA).
 * Per workspace, only where payments come from Xero and the owner hasn't
 * switched it off (Settings → Integrations → Xero) — runAutomaticXeroCheck.
 *
 * ITS OWN ROUTE: the automations route's phases send things and guard their budget
 * for that; a run of Xero calls competing for it would lose, correctly.
 */
const RESERVE_MS = 8_000; // a Xero call can take seconds — never start one this close to the end

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const MIN_START_BUDGET_MS = 10_000;
  const routeBudget = await warmUpForCron("xero-payments", { routeBudgetMs: 50_000, minStartBudgetMs: MIN_START_BUDGET_MS });
  if (!routeBudget.ok) return NextResponse.json({ ok: false, skipped: routeBudget.reason }, { status: 503 });

  try {
    const runs = await runCronPerTenant(async (tenantId, budget) => {
        if (budget.shouldStop(RESERVE_MS)) return { skipped: "insufficient-budget" as const };
        // Dormant enforcement runs once, unscoped: the founding workspace — the same value its scope carries.
        return runAutomaticXeroCheck(tenantId ?? DEFAULT_TENANT_ID, () => budget.shouldStop(RESERVE_MS));
      },
      {
        maxRuntimeMs: routeBudget.remainingMs,
        minStartBudgetMs: MIN_START_BUDGET_MS,
        concurrency: 2,
        rotationWindowMs: 60 * 60 * 1000,
        onError: (tenantId, error) => logError(`xero-payments:${tenantId}`, error, undefined, { tenantId }),
      },
    );
    return NextResponse.json({ ok: true, tenants: runs });
  } catch (error) {
    await logError("xero-payments", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Xero payments check failed" }, { status: 500 });
  }
}
