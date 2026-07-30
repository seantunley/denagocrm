import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  collectSource,
  competitorsDueForResearch,
  competitorsNeedingDiscovery,
  discoverSources,
  dueSourceIds,
  researchCompetitor,
} from "@/lib/competitors";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { logError } from "@/lib/errorLog";
import { warmUpForCron } from "@/lib/cronPreflight";
import { runCronPerTenant, type CronSliceContext } from "@/lib/tenantCron";

export const maxDuration = 300;

// CRON_SECRET only (constant-time), matching the other cron routes — no intake
// key, no query-string secret. Swap for the shared isAuthorizedCron() helper
// once PR #83 (cron auth) merges.
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const provided = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTenantWatch(budget: CronSliceContext) {
  if (!(await getEnabledModuleIds()).has("automation")) {
    return { checked: 0, changed: 0, errors: 0, discovered: 0, researched: 0, budgetExhausted: false };
  }

  const ids = await dueSourceIds(25);
  let checked = 0;
  let changed = 0;
  let errors = 0;
  let budgetExhausted = false;

  // A source fetch has a 20-second hard timeout. Do not start another one unless
  // enough route budget remains for it plus the politeness delay.
  for (const id of ids) {
    if (budget.shouldStop(25_000)) {
      budgetExhausted = true;
      break;
    }
    const res = await collectSource(id).catch(() => ({ ok: false, changed: false }));
    checked += 1;
    if (res.changed) changed += 1;
    if (!res.ok) errors += 1;
    await sleep(1500);
  }

  // Discovery and deep research can each be materially more expensive than a
  // page-diff. Check the shared deadline before every item instead of multiplying
  // the full legacy workload by tenant count.
  let discovered = 0;
  if (!budget.shouldStop(90_000)) {
    for (const id of await competitorsNeedingDiscovery(2)) {
      if (budget.shouldStop(90_000)) {
        budgetExhausted = true;
        break;
      }
      const res = await discoverSources(id).catch(() => ({ ok: false }));
      if (res.ok) discovered += 1;
    }
  } else {
    budgetExhausted = true;
  }

  let researched = 0;
  if (!budget.shouldStop(90_000)) {
    for (const id of await competitorsDueForResearch(2)) {
      if (budget.shouldStop(90_000)) {
        budgetExhausted = true;
        break;
      }
      const res = await researchCompetitor(id).catch(() => ({ ok: false }));
      if (res.ok) researched += 1;
    }
  } else {
    budgetExhausted = true;
  }

  return { checked, changed, errors, discovered, researched, budgetExhausted };
}

/**
 * Daily competitor watch. Work is fairly rotated across tenants and admitted
 * through a bounded worker pool with an explicit route budget.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Wake a suspended endpoint first; the sweep runs exactly once, on whatever
  // budget survives the warm-up. See dbRetry.ts.
  //
  // `routeBudget`, not `budget` — the slice callback below already binds a
  // per-slice budget of its own.
  const MIN_START_BUDGET_MS = 45_000;
  const routeBudget = await warmUpForCron("competitor-watch", {
    routeBudgetMs: 270_000,
    minStartBudgetMs: MIN_START_BUDGET_MS,
  });
  if (!routeBudget.ok) {
    return NextResponse.json({ ok: false, skipped: routeBudget.reason }, { status: 503 });
  }

  const runs = await runCronPerTenant(async (_tenantId, budget) => runTenantWatch(budget), {
    maxRuntimeMs: routeBudget.remainingMs,
    minStartBudgetMs: MIN_START_BUDGET_MS,
    concurrency: 2,
    rotationWindowMs: 24 * 60 * 60 * 1000,
    onError: (tenantId, error) => logError(`competitor-watch:${tenantId}`, error),
  });

  const dormant = runs.length === 1 && runs[0].tenantId === null ? runs[0] : null;
  if (dormant?.status === "ok") {
    return NextResponse.json({ ok: true, ...dormant.result });
  }
  return NextResponse.json({ ok: true, tenants: runs });
}
