import "server-only";
import { basePrisma } from "./db";
import { tenantEnforcing } from "./tenantEnforcement";
import { runInTenantScope } from "./tenantScope";

/**
 * Cron scoping (Phase C, step 2b-C4). Background jobs run with NO logged-in staff
 * user, so under enforcement they resolve no tenant and every guarded query fails
 * closed. Platform-global sweeps (backup, security) use `withSystemScope`; the
 * per-TENANT business queues (journeys, automations, competitor-watch, campaign /
 * survey / lifecycle) use the runner below.
 */

/** Active tenants a per-tenant cron must sweep. Suspended/deleted tenants are excluded. */
export async function activeTenantIds(): Promise<string[]> {
  const rows = await basePrisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Tenant" WHERE "active" = true ORDER BY "createdAt" ASC`;
  return rows.map((r) => r.id);
}

export type CronSliceContext = {
  tenantId: string | null;
  deadlineAt: number | null;
  timeRemainingMs: () => number;
  shouldStop: (reserveMs?: number) => boolean;
};

export type CronRun<T> =
  | { tenantId: string | null; status: "ok"; result: T; durationMs: number }
  | { tenantId: string; status: "error"; error: string; durationMs: number }
  | { tenantId: string; status: "skipped"; reason: "deadline"; durationMs: 0 };

export type RunCronPerTenantOptions = {
  /** Wall-clock budget for the whole enforcing-mode fan-out. */
  maxRuntimeMs?: number;
  /** Do not admit another tenant unless at least this much budget remains. */
  minStartBudgetMs?: number;
  /** Bounded number of tenant slices running at once. */
  concurrency?: number;
  /** Rotate the first tenant once per window so fixed ordering cannot starve later tenants. */
  rotationWindowMs?: number;
  /** Best-effort per-tenant error reporting; a reporting failure never stops the sweep. */
  onError?: (tenantId: string, error: unknown) => Promise<void> | void;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
};

const DEFAULT_MAX_RUNTIME_MS = 55_000;
const DEFAULT_MIN_START_BUDGET_MS = 5_000;
const DEFAULT_ROTATION_WINDOW_MS = 15 * 60 * 1000;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function rotateTenantIds(ids: string[], startedAt: number, windowMs: number): string[] {
  if (ids.length < 2) return ids;
  const offset = Math.floor(startedAt / Math.max(1, windowMs)) % ids.length;
  return [...ids.slice(offset), ...ids.slice(0, offset)];
}

function sliceContext(
  tenantId: string | null,
  deadlineAt: number | null,
  now: () => number,
): CronSliceContext {
  return {
    tenantId,
    deadlineAt,
    timeRemainingMs: () => deadlineAt === null ? Number.POSITIVE_INFINITY : Math.max(0, deadlineAt - now()),
    shouldStop: (reserveMs = 0) => deadlineAt !== null && now() + Math.max(0, reserveMs) >= deadlineAt,
  };
}

/**
 * Run one cron `slice` with the correct tenant scope.
 *
 * DORMANT: run once, unscoped, and preserve the old throw/response behaviour.
 *
 * ENFORCING: rotate the starting tenant, execute with bounded concurrency, stop
 * admitting new tenants at the explicit deadline, and capture each tenant failure
 * instead of aborting the remaining sweep. The returned array includes `error` and
 * `skipped` entries so operators can see partial completion.
 *
 * CONTRACT: `slice` must be async and AWAIT its DB work internally. It should use
 * `context.shouldStop(reserveMs)` between expensive phases so already-running work
 * also respects the route budget without unsafe promise-race cancellation.
 */
export async function runCronPerTenant<T>(
  slice: (tenantId: string | null, context: CronSliceContext) => Promise<T>,
  options: RunCronPerTenantOptions = {},
): Promise<Array<CronRun<T>>> {
  const now = options.now ?? Date.now;
  if (!tenantEnforcing()) {
    const startedAt = now();
    const result = await slice(null, sliceContext(null, null, now));
    return [{ tenantId: null, status: "ok", result, durationMs: Math.max(0, now() - startedAt) }];
  }

  const startedAt = now();
  const maxRuntimeMs = Math.max(1, options.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS);
  const minStartBudgetMs = Math.min(
    maxRuntimeMs,
    Math.max(0, options.minStartBudgetMs ?? DEFAULT_MIN_START_BUDGET_MS),
  );
  const deadlineAt = startedAt + maxRuntimeMs;
  const startDeadlineAt = deadlineAt - minStartBudgetMs;
  const orderedTenantIds = rotateTenantIds(
    await activeTenantIds(),
    startedAt,
    options.rotationWindowMs ?? DEFAULT_ROTATION_WINDOW_MS,
  );
  if (orderedTenantIds.length === 0) return [];

  const concurrency = Math.min(
    orderedTenantIds.length,
    Math.max(1, Math.floor(options.concurrency ?? 2)),
  );
  const completed = new Map<string, CronRun<T>>();
  let cursor = 0;

  const worker = async () => {
    while (true) {
      if (now() >= startDeadlineAt) return;
      const index = cursor++;
      if (index >= orderedTenantIds.length) return;
      const tenantId = orderedTenantIds[index];
      const runStartedAt = now();
      try {
        const result = await runInTenantScope(
          { tenantId, system: false },
          async () => await slice(tenantId, sliceContext(tenantId, deadlineAt, now)),
        );
        completed.set(tenantId, {
          tenantId,
          status: "ok",
          result,
          durationMs: Math.max(0, now() - runStartedAt),
        });
      } catch (error) {
        completed.set(tenantId, {
          tenantId,
          status: "error",
          error: errorMessage(error),
          durationMs: Math.max(0, now() - runStartedAt),
        });
        if (options.onError) {
          try {
            await options.onError(tenantId, error);
          } catch {
            // Reporting must never turn one tenant failure back into a global abort.
          }
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return orderedTenantIds.map((tenantId) =>
    completed.get(tenantId) ?? {
      tenantId,
      status: "skipped" as const,
      reason: "deadline" as const,
      durationMs: 0 as const,
    }
  );
}
