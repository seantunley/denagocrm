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

/** Events older than this are dropped, whatever their status. */
export const EVENT_RETENTION_DAYS = 30;
/** Runs older than this are dropped — unless the per-journey floor saves them. */
export const RUN_RETENTION_DAYS = 60;
/** Runs kept per journey regardless of age, so a quiet journey still has a trace. */
export const RUNS_KEPT_PER_JOURNEY = 20;
/** Ceiling per sweep, so one tick cannot spend its whole budget deleting. */
const MAX_DELETES_PER_SWEEP = 2_000;

export type RetentionResult = { events: number; runs: number };

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
 * So one indexed query decides whether there is any work at all, and the floor
 * is computed only for the journeys that actually have stale runs.
 */
export async function pruneJourneyTraces(): Promise<RetentionResult> {
  const eventCutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const runCutoff = new Date(Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Events are self-contained: once processed they are a record of a decision,
  // and the runs they produced carry their own history.
  const { count: events } = await prisma.journeyEvent.deleteMany({
    where: { createdAt: { lt: eventCutoff }, status: { in: ["processed", "failed"] } },
  });

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
