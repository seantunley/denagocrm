import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { logError } from "@/lib/errorLog";
import { warmUpForCron } from "@/lib/cronPreflight";
import { runCronPerTenant } from "@/lib/tenantCron";
import { sendDueScheduledEmails } from "@/lib/emailDrafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Emails people scheduled in the composer (lib/emailDrafts.ts), sent when due.
 * Every 30 minutes, on the hour and the half hour — the times the composer
 * offers, and the minutes the other crons already wake the database for
 * (tests/cronScheduleCost.test.ts: the cadence is a bill).
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const budget = await warmUpForCron("scheduled-emails", { routeBudgetMs: 55_000, minStartBudgetMs: 5_000 });
  if (!budget.ok) return NextResponse.json({ ok: false, skipped: budget.reason }, { status: 503 });

  const runs = await runCronPerTenant(async (tenantId, budget) => {
      // Stops between emails, never in the middle of one (sendDueScheduledEmails checks before each).
      if (budget.shouldStop(10_000)) return { skipped: "deadline" as const };
      return sendDueScheduledEmails(tenantId, budget);
    },
    {
      maxRuntimeMs: budget.remainingMs,
      minStartBudgetMs: 10_000,
      concurrency: 2,
      onError: async (tenantId, error) => {
        await logError("scheduled-emails-cron", error, `tenant ${tenantId}`, { tenantId }).catch(() => {});
      },
    },
  );

  const failed = runs.filter((run) => run.status === "error").length;
  return NextResponse.json({ ok: failed === 0, runs }, { status: failed ? 207 : 200 });
}
