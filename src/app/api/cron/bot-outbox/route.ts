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

  const runs = await runCronPerTenant(async (_tenantId, budget) => {
<<<<<<< HEAD
=======
    // Hand the slice context DOWN, not just check it here. The drain loops over
    // conversations and sends to a provider inside each one; without the budget
    // it runs until the platform kills it, possibly mid-send.
>>>>>>> origin/agent/bot-approved-knowledge
    if (budget.shouldStop(4_000)) return { skipped: "deadline" as const };
    return flushBotOutbox(50, budget);
  },
    {
      maxRuntimeMs: budget.remainingMs,
      minStartBudgetMs: 4_000,
      concurrency: 2,
      onError: async (tenantId, error) => {
        await logError("bot-outbox-cron", error, `tenant ${tenantId}`).catch(() => {});
      },
    },
  );

  const failed = runs.filter((run) => run.status === "error").length;
  return NextResponse.json({ ok: failed === 0, runs }, { status: failed ? 207 : 200 });
}
