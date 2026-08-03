import "server-only";
import { prisma } from "./db";

/**
 * Journey traces are diagnostic, not a record. They have to be pruned.
 *
 * Nothing pruned them. JourneyEvent, JourneyRun and JourneyStepLog all grew
 * without bound — every event the engine has ever seen, every run, and a log
 * row per step of each. On a busy workspace that is the fastest-growing data in
 * the app, and it is the data with the least long-term value: nobody asks why a
 * journey enrolled someone eleven weeks ago.
 *
 * Home Assistant keeps the last 5 traces per automation (configurable to 20+).
 * That shape — keep the most recent N PER automation — is the right one and the
 * reason is worth stating: an age-only rule silently empties the trace for a
 * quiet journey, which is exactly the journey you are most likely to be
 * debugging. So this does both: an age floor for the bulk, and a per-journey
 * floor so every journey keeps its most recent runs however quiet it is.
 */

/**
 * Events older than this are dropped, whatever their status.
 *
 * MUST STAY LONGER THAN THE LONGEST POSSIBLE WAIT. A `wait_for_trigger` step
 * parks a run and polls `JourneyEvent` for an event newer than the moment it
 * armed, for up to `JOURNEY_LIMITS.waitDays` (30). If that ceiling and this
 * window were equal, the final poll of a maximal wait would race the sweep that
 * deletes the very event it is looking for — and the failure would be a journey
 * that quietly timed out instead of continuing, with the event sitting in
 * neither the table nor the trace.
 *
 * Hence 45 rather than 30: fifteen days of headroom over that ceiling. If
 * `waitDays` is ever raised, raise this first.
 */
export const EVENT_RETENTION_DAYS = 45;
/** Runs older than this are dropped — unless the per-journey floor saves them. */
export const RUN_RETENTION_DAYS = 60;
/** Runs kept per journey regardless of age, so a quiet journey still has a trace. */
export const RUNS_KEPT_PER_JOURNEY = 20;
/** Ceiling per sweep, so one tick cannot spend its whole budget deleting. */
export const MAX_DELETES_PER_SWEEP = 2_000;

export type RetentionResult = { events: number; runs: number };

/**
 * An event is prunable once the engine has finished with it. `pending` is work
 * not yet done, and deleting it would drop a trigger on the floor.
 *
 * An allowlist for the same reason as `CLOSED_RUN_STATUSES` below: a new
 * in-flight status added later is excluded automatically.
 */
const PRUNABLE_EVENT_STATUSES = ["processed", "failed"];

/**
 * A run is a trace once it is CLOSED. Before that it is live state — `queued`,
 * `running`, `waiting` and #304's `blocked` are all still in flight.
 *
 * An allowlist of closed statuses rather than a denylist of live ones, on
 * purpose: a new live status added later is excluded automatically, where a
 * denylist would silently start deleting it.
 */
const CLOSED_RUN_STATUSES = ["completed", "failed", "cancelled"];

/**
 * Prune journey traces. Safe to run every tick; deletes nothing when there is
 * nothing old enough.
 *
 * SHAPED AROUND THE EMPTY CASE, because that is nearly every call. The journey
 * cron runs this once PER TENANT per tick — `runCronPerTenant` establishes a
 * scope and calls `runJourneyEngine` inside it — so whatever happens here
 * happens tenants-times-ticks often. Computing the per-journey floor up front
 * costs one query per journey, for every tenant, on every tick, to almost
 * always delete nothing: a worse problem than the one being fixed.
 *
 * So one indexed query PER TABLE decides whether that table has any work at
 * all, and the per-journey floor is computed only for the journeys that
 * actually have stale runs.
 *
 * BOTH sweeps are bounded to MAX_DELETES_PER_SWEEP. A tenant that has been
 * running journeys for a year has a backlog measured in millions of rows, and
 * an unbounded `deleteMany` over it is one statement that holds row locks on
 * the whole expired set for as long as it takes — which on that tenant is
 * longer than the cron has. Bounded sweeps make no less progress in the long
 * run; they just make it in pieces that fit inside a tick.
 */
export async function pruneJourneyTraces(): Promise<RetentionResult> {
  const eventCutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const runCutoff = new Date(Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Events are self-contained: once processed they are a record of a decision,
  // and the runs they produced carry their own history.
  //
  // Selected then deleted by id, like the run sweep below, rather than a bare
  // `deleteMany` over the whole expired backlog. Same index scan on
  // (status, createdAt), same cost when there is nothing to do — but the delete
  // that follows is now a known 2,000 rows instead of however many a tenant has
  // accumulated.
  //
  // Oldest first so the backlog drains from the far end: a sweep that took an
  // arbitrary 2,000 would leave the oldest rows to be re-scanned every tick.
  const expiredEvents = await prisma.journeyEvent.findMany({
    where: { createdAt: { lt: eventCutoff }, status: { in: PRUNABLE_EVENT_STATUSES } },
    orderBy: { createdAt: "asc" },
    take: MAX_DELETES_PER_SWEEP,
    select: { id: true },
  });
  const events =
    expiredEvents.length === 0
      ? 0
      : (
          await prisma.journeyEvent.deleteMany({
            where: { id: { in: expiredEvents.map((event) => event.id) } },
          })
        ).count;

  // THE EARLY OUT. One index scan on (status, createdAt); on the overwhelming
  // majority of ticks it comes back empty and the sweep is over.
  //
  // Oldest first, deliberately: the oldest runs are the ones the per-journey
  // floor is least likely to protect, so the bounded window is spent on rows
  // that can actually be deleted. Newest-first would fill the window with
  // recent-but-past-cutoff runs that the floor then saves, and the sweep would
  // make no progress at all while the backlog behind it kept growing.
  const candidates = await prisma.journeyRun.findMany({
    where: { createdAt: { lt: runCutoff }, status: { in: CLOSED_RUN_STATUSES } },
    orderBy: { createdAt: "asc" },
    take: MAX_DELETES_PER_SWEEP,
    select: { id: true, journeyId: true },
  });
  if (candidates.length === 0) return { events, runs: 0 };

  // Only now, and only for the journeys that actually have something stale.
  const journeyIds = [...new Set(candidates.map((run) => run.journeyId))];
  const protectedIds = new Set<string>();
  for (const journeyId of journeyIds) {
    const recent = await prisma.journeyRun.findMany({
      where: { journeyId },
      orderBy: { createdAt: "desc" },
      take: RUNS_KEPT_PER_JOURNEY,
      select: { id: true },
    });
    for (const run of recent) protectedIds.add(run.id);
  }

  const doomed = candidates.filter((run) => !protectedIds.has(run.id)).map((run) => run.id);
  if (doomed.length === 0) return { events, runs: 0 };

  // Step logs cascade from JourneyRun (onDelete: Cascade), so deleting the run
  // takes its whole timeline with it — no orphaned rows to sweep separately.
  const { count: runs } = await prisma.journeyRun.deleteMany({ where: { id: { in: doomed } } });
  return { events, runs };
}
