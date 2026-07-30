import "server-only";

import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { warmUpDatabase } from "@/lib/dbRetry";

export type CronBudget =
  | { ok: true; remainingMs: number }
  | { ok: false; reason: "database-unreachable" | "insufficient-budget"; remainingMs: number };

export type CronPreflightOptions = {
  /** Wall-clock this handler may use in total, inside the platform maxDuration. */
  routeBudgetMs: number;
  /** Do not start a sweep with less than this left. */
  minStartBudgetMs: number;
  /** Cap on the warm-up itself, so it cannot eat the sweep's time. */
  warmUpBudgetMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
};

/**
 * Wakes the database, then reports how much of the route's budget SURVIVED.
 *
 * `SELECT 1` touches nothing and sends nothing, so retrying it is free — unlike
 * the sweep, which emails and pushes and must run exactly once (see dbRetry.ts).
 *
 * The budget arithmetic is the point, not decoration. Warm-up time is real
 * wall-clock: a connection attempt can hang for seconds before failing, and
 * three attempts plus backoff used to run entirely OUTSIDE the sweep's budget.
 * A sweep then started with its full 45 or 50 seconds regardless of how long
 * waking the database had already taken, so the platform could kill the
 * function mid-write. The sweep now gets what is actually left, and is skipped
 * outright when that is too little to be worth starting.
 */
export async function warmUpForCron(label: string, options: CronPreflightOptions): Promise<CronBudget> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const deadlineAt = startedAt + options.routeBudgetMs;
  const warmUpBudgetMs = options.warmUpBudgetMs ?? 15_000;

  const awake = await warmUpDatabase(() => basePrisma.$queryRaw`SELECT 1`, {
    deadlineAt: Math.min(startedAt + warmUpBudgetMs, deadlineAt),
    now,
    onRetry: (attempt, error) => logError("cron-db-warmup", error, `${label} attempt ${attempt}`),
  });

  const remainingMs = Math.max(0, deadlineAt - now());

  if (!awake) {
    await logError(
      "cron-db-warmup",
      new Error("Database still unreachable after warm-up; skipping this run"),
      `${label} (${remainingMs}ms of budget left)`,
    );
    return { ok: false, reason: "database-unreachable", remainingMs };
  }

  // Woken, but so late that a sweep would be racing the platform timeout.
  // Skipping is honest: the next tick is minutes away and picks the work up.
  if (remainingMs < options.minStartBudgetMs) {
    await logError(
      "cron-db-warmup",
      new Error(`Database woke with only ${remainingMs}ms left; skipping this run`),
      label,
    );
    return { ok: false, reason: "insufficient-budget", remainingMs };
  }

  return { ok: true, remainingMs };
}
