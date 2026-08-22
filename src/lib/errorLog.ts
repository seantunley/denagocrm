import { subDays } from "date-fns";
import { basePrisma } from "./db";
import { redactUrl } from "./redactUrl";
import { attributionTenantId } from "./actingTenant";

/**
 * How long a logged error is kept.
 *
 * Longer than TRASH_RETENTION_DAYS (60) on purpose: an error is diagnostic
 * material, and the questions it answers ("has this been happening since the
 * July deploy?") are asked further back than the questions Trash answers. On
 * 2026-08-13 production held 1,190 rows spanning 29 days — roughly 40 a day — so
 * 90 days settles at a few thousand rows and deletes nothing that exists today.
 */
export const ERROR_LOG_RETENTION_DAYS = 90;

/** Bounded per pass so one sweep cannot build an unbounded DELETE. */
const PRUNE_BATCH = 500;
const PRUNE_MAX_BATCHES = 200;

/**
 * Drop errors older than the retention window.
 *
 * ErrorLog is the only table in the database with NO pruning at all and a write
 * path that fires on every failure — the one table whose size is driven by things
 * going wrong. It is also 1.9 MB at 1,190 rows (each row carries a stack), so it
 * is the largest table in the database despite being the least valuable, and every
 * policy on it is evaluated as a sequential scan. None of that matters at this
 * size; all of it matters at a hundred thousand.
 *
 * Deliberately NOT tenant-scoped, and it must not become so: ErrorLog is a GLOBAL
 * model precisely because errors happen where no tenant is known, and those rows
 * (`tenantId` null) are the ones a per-tenant sweep would never reach — so they
 * would be the only rows that accumulate forever.
 *
 * Batched, and each DELETE RE-ASSERTS the cutoff rather than trusting the ids the
 * scan returned. Same guarded-delete rule purgeTrash follows: the row must still
 * qualify at the moment it is removed.
 *
 * Returns the number removed. The caller decides whether a failure matters — this
 * never throws, because a retention sweep is not worth failing a backup run over.
 */
export async function pruneErrorLog(now: Date = new Date()): Promise<number> {
  const cutoff = subDays(now, ERROR_LOG_RETENTION_DAYS);
  let removed = 0;

  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
    const stale = await basePrisma.errorLog.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: PRUNE_BATCH,
    });
    if (stale.length === 0) break;

    const { count } = await basePrisma.errorLog.deleteMany({
      where: { id: { in: stale.map((row) => row.id) }, createdAt: { lt: cutoff } },
    });
    removed += count;
    // A scan that finds rows while the delete matches none would otherwise spin
    // until the batch cap. Stop on the first pass that removes nothing.
    if (count === 0) break;
  }

  return removed;
}

/**
 * Best-effort owning tenant for an error.
 *
 * ErrorLog is a GLOBAL model (see GLOBAL_MODELS in ./tenantGuard for the decision
 * and what it costs): this column is ATTRIBUTION, so that per-tenant error health
 * and the per-tenant first-error alert throttle have something to key on. A null is
 * a correct outcome here, not a missed stamp — an error raised before any tenant is
 * known belongs to nobody, and inventing an owner would make a healthy workspace
 * look broken.
 *
 * The resolution order is the shared one ({@link attributionTenantId}): an established
 * scope, `system` and platform-console requests deliberately unattributed, then the
 * acting staff session. Shared rather than restated so error attribution and record
 * ownership cannot drift apart — this file used to carry its own copy, and a copy
 * is a thing that goes stale silently. Anything that throws is swallowed:
 * attribution must never be able to break logging.
 */
async function tenantForError(): Promise<string | null> {
  // One question, asked of the module that owns the resolution order. The
  // swallow that used to live here returned null for every enforced request with
  // no bound scope - which is exactly the failure most worth seeing, filed where
  // the tenant own System Log could not show it. See attributionTenantId.
  return attributionTenantId();
}

/**
 * Files a system error where it can actually be seen (Settings → System Log)
 * instead of evaporating with the serverless function. Never throws. A push
 * fires at most once per 30 minutes PER TENANT so a crash-loop can't melt your
 * phone — and so one tenant's error storm cannot silence another tenant's alert.
 */
export type LogErrorOptions = {
  /**
   * Attribute to this tenant instead of inferring one. For a caller that KNOWS
   * the owner — an inbound webhook, which has no staff session to fall back to.
   */
  tenantId?: string | null;
  /**
   * Whether this may raise the first-error push. Default true. Set false for an
   * EXPECTED, self-healing condition: a lease contention is the system working,
   * and while enforcement is dormant `sendPushToAll` has no scope to narrow to,
   * so it would notify every subscription on the install.
   */
  alert?: boolean;
};

export async function logError(
  scope: string,
  err: unknown,
  context?: string,
  options?: LogErrorOptions,
): Promise<void> {
  try {
    // EVERY string that lands in ErrorLog goes through redactUrl first. The
    // System Log is rendered to workspace owners and to platform admins, and a
    // /signing, /approvals, /s or /api/track URL is a working credential — so it
    // must be stripped at the write, not at each of the ~25 logError call sites.
    // Message and stack are swept too: a failing fetch or a Prisma error commonly
    // quotes the URL it was handed.
    const raw =
      err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
    const message = redactUrl(raw);
    const stack = err instanceof Error && err.stack ? redactUrl(err.stack).slice(0, 4000) : undefined;
    const tenantId = options?.tenantId !== undefined ? options.tenantId : await tenantForError();

    await basePrisma.errorLog.create({
      data: {
        scope,
        message: message.slice(0, 1000),
        stack,
        context: context ? redactUrl(context).slice(0, 1000) : context,
        tenantId,
      },
    });

    // Throttle PER TENANT. Counting globally meant a noisy tenant suppressed the
    // first-error alert for every other tenant — the alert would simply never
    // fire for them, silently. Unattributed errors (tenantId null) throttle as
    // their own bucket rather than joining an arbitrary tenant's.
    if (options?.alert === false) return;
    const recent = await basePrisma.errorLog.count({
      where: {
        createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
        tenantId,
      },
    });
    if (recent === 1) {
      const { sendPushToAll } = await import("./push");
      await sendPushToAll(
        {
          title: "⚠ System error",
          body: `${scope}: ${message.slice(0, 90)}`,
          url: "/settings?tab=system",
        },
        "system_error"
      ).catch((pushError) => {
        // Never recurse through logError here: push is called from the logger.
        // The runtime console is the durable fallback when alert delivery fails.
        console.error("[error-log-alert-failure]", pushError);
      });
    }
  } catch (loggingError) {
    // The logger must never become the caller's error, but its own failure must
    // still be observable when the database is unavailable. Do not recurse.
    console.error("[error-log-write-failure]", { scope, context }, loggingError);
  }
}
