import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { logError } from "@/lib/errorLog";
import { warmUpForCron } from "@/lib/cronPreflight";
import { runCronPerTenant } from "@/lib/tenantCron";
import { flushBotOutbox } from "@/lib/botOutbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const budget = await warmUpForCron("bot-outbox", {
    routeBudgetMs: 55_000,
    minStartBudgetMs: 5_000,
  });
  if (!budget.ok) return NextResponse.json({ ok: false, skipped: budget.reason }, { status: 503 });

  // The slice's tenant is PASSED THROUGH now instead of being discarded. Under
  // enforcement it is the workspace this slice fans out for; on the dormant single
  // sweep it is null, which tells the drain to cover every workspace and bind each
  // conversation's own tenant. Dropping it was what made the dormant drain the
  // founding tenant's queue and nobody else's.
  const runs = await runCronPerTenant(async (tenantId, budget) => {
    if (budget.shouldStop(4_000)) return { skipped: "deadline" as const };
    return flushBotOutbox(50, budget, tenantId);
  },
    {
      maxRuntimeMs: budget.remainingMs,
      minStartBudgetMs: 4_000,
      concurrency: 2,
      onError: async (tenantId, error) => {
        // The tenant was already being written into the free-text context; put it in
        // the column too, where per-tenant error health can actually read it.
        await logError("bot-outbox-cron", error, `tenant ${tenantId}`, { tenantId }).catch(() => {});
      },
    },
  );

  const failed = runs.filter((run) => run.status === "error").length;
  return NextResponse.json({ ok: failed === 0, runs }, { status: failed ? 207 : 200 });
}
