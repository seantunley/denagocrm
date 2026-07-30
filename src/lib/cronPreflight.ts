import "server-only";

import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { warmUpDatabase } from "@/lib/dbRetry";

/**
 * Wakes the database before a cron sweep runs.
 *
 * `SELECT 1` touches nothing and sends nothing, so retrying it is free — unlike
 * the sweep itself, which emails and pushes and must therefore run exactly once
 * (see dbRetry.ts for why retrying the sweep was the wrong shape).
 *
 * Returns false when the endpoint is still unreachable after the retries. The
 * caller should then SKIP the run: the sweep would only fail on its own first
 * query, and skipping one tick is the honest outcome — the next tick is minutes
 * away and the work is picked up then.
 */
export async function warmUpForCron(label: string): Promise<boolean> {
  const awake = await warmUpDatabase(() => basePrisma.$queryRaw`SELECT 1`, {
    onRetry: (attempt, error) => logError("cron-db-warmup", error, `${label} attempt ${attempt}`),
  });
  if (!awake) {
    await logError(
      "cron-db-warmup",
      new Error("Database still unreachable after warm-up attempts; skipping this run"),
      label,
    );
  }
  return awake;
}
