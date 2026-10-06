import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { logError } from "@/lib/errorLog";
import { warmUpForCron } from "@/lib/cronPreflight";
import { runCronPerTenant } from "@/lib/tenantCron";
import { runDueAssistantSchedules, SCHEDULE_RUN_RESERVE_MS } from "@/lib/assistantScheduleRun";
import { runAssistantWatches } from "@/lib/assistantWatch";

/**
 * Scheduled assistant questions ("every Monday at 7, which deals went quiet?")
 * and watches ("tell me when Anna opens her quote"), run as the person who set
 * them up.
 *
 * ITS OWN ROUTE for the same reason research has one: one run is a full
 * assistant answer — up to about three minutes on the ChatGPT subscription —
 * so it gets Vercel's full 300 seconds and can't hold up any other queue.
 *
 * Every 30 minutes, on the same beat as the other frequent crons, so it adds no
 * database wake-ups of its own (tests/cronScheduleCost.test.ts). That beat is
 * the granularity: a question set for 07:10 runs at the 07:30 tick.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MIN_START_BUDGET_MS = 15_000;
/** The watch pass's share of a tick: the schedules keep at least ~230 s. */
const WATCH_BUDGET_MS = 60_000;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const routeBudget = await warmUpForCron("assistant", {
    routeBudgetMs: 290_000,
    minStartBudgetMs: MIN_START_BUDGET_MS,
  });
  if (!routeBudget.ok) {
    return NextResponse.json({ ok: false, skipped: routeBudget.reason }, { status: 503 });
  }

  // Watches FIRST, every workspace: plain queries, seconds not minutes, so a
  // long scheduled question can't starve them. Capped, so the schedules always
  // keep the rest of the tick. A watch failure must not stop the schedules —
  // caught here, logged by its name only, never a record or a label.
  const startedAt = Date.now();
  const watches = await runCronPerTenant(
    async (tenantId, budget) =>
      runAssistantWatches(budget).catch(async (error: unknown) => {
        await logError("assistant-schedule", "watch run failed", error instanceof Error ? error.name : "unknown", { tenantId });
        return { checked: 0, fired: 0 };
      }),
    { maxRuntimeMs: Math.min(WATCH_BUDGET_MS, routeBudget.remainingMs), rotationWindowMs: 30 * 60 * 1000 },
  ).catch(async (error: unknown) => {
    await logError("assistant-schedule", "watch run failed", error instanceof Error ? error.name : "unknown");
    return [];
  });

  const runs = await runCronPerTenant(async (_tenantId, budget) => {
    // A workspace reached with too little left for one run is left for the next tick.
    if (budget.shouldStop(SCHEDULE_RUN_RESERVE_MS)) return { ran: 0, skipped: "insufficient-budget" as const };
    return runDueAssistantSchedules(budget);
  }, {
    maxRuntimeMs: routeBudget.remainingMs - (Date.now() - startedAt),
    minStartBudgetMs: MIN_START_BUDGET_MS,
    // One workspace at a time: a run holds the function for minutes, and two
    // in parallel would only halve what each could fit.
    concurrency: 1,
    // Who goes FIRST moves on every tick. With the default 15-minute window and
    // ticks at :00 and :30 the start offset was always even, so the same
    // workspace led every time — and its runs could use up every tick.
    rotationWindowMs: 30 * 60 * 1000,
    // The error's name only — a failure deep in a run must not carry a
    // question or an answer into the log.
    onError: (tenantId, error) =>
      logError("assistant-schedule", "scheduled run failed", error instanceof Error ? error.name : "unknown", { tenantId }),
  });

  const failed = runs.filter((run) => run.status === "error").length;
  return NextResponse.json({ ok: failed === 0, watches, runs }, { status: failed ? 207 : 200 });
}
