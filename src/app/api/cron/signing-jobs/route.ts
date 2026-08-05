import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { logError } from "@/lib/errorLog";
import { runCronPerTenant } from "@/lib/tenantCron";
import { runSigningJobs } from "@/lib/signing/jobWorker";
import { runSigningTransitionJobs } from "@/lib/signing/transitionWorker";
import { signingReadiness } from "@/lib/signing/securityPolicy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_RUNTIME_MS = 280_000;
const MIN_START_BUDGET_MS = 15_000;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const readiness = signingReadiness();
  if (!readiness.ready) {
    const message = `Signing worker refused to run: ${readiness.failures.join("; ")}`;
    await logError("signing-readiness", new Error(message), "durable signing job cron").catch(() => {});
    return NextResponse.json({ error: message, readiness }, { status: 503 });
  }

  const runs = await runCronPerTenant(
    async (tenantId, budget) => {
      const concreteTenantId = tenantId ?? DEFAULT_TENANT_ID;
      if (budget.shouldStop(10_000)) {
        return {
          transitions: { claimed: 0, completed: 0, retried: 0, dead: 0, leased: 0 },
          completion: { claimed: 0, completed: 0, retried: 0, dead: 0, leased: 0 },
          skipped: "deadline" as const,
        };
      }

      // A committed signature/decline/approval may create or close the request,
      // which in turn transactionally enqueues completion jobs. Drain those
      // transition continuations first, then process the newly materialised
      // completion work during the same tenant run when budget permits.
      const transitions = await runSigningTransitionJobs(concreteTenantId, 20);
      if (budget.shouldStop(10_000)) {
        return {
          transitions,
          completion: { claimed: 0, completed: 0, retried: 0, dead: 0, leased: 0 },
          skipped: "deadline-after-transitions" as const,
        };
      }
      const completion = await runSigningJobs(concreteTenantId, 20);
      return { transitions, completion };
    },
    {
      maxRuntimeMs: MAX_RUNTIME_MS,
      minStartBudgetMs: MIN_START_BUDGET_MS,
      concurrency: 2,
      onError: async (tenantId, error) => {
        const message = error instanceof Error ? error.message : String(error);
        await logError("signing-job-cron", error, `tenant ${tenantId}: ${message}`).catch(() => {});
      },
    },
  );

  const failed = runs.filter((run) => run.status === "error").length;
  const skipped = runs.filter((run) => run.status === "skipped").length;
  return NextResponse.json(
    {
      ok: failed === 0,
      partial: skipped > 0,
      readiness,
      runs,
    },
    { status: failed > 0 ? 207 : 200 },
  );
}
