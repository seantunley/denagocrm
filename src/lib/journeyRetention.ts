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
 * Prune journey traces. Safe to run every tick; deletes nothing when there is
 * nothing old enough.
 *
 * Only CLOSED runs are eligible. An open run is live state, not a trace — and a
 * `waiting` run legitimately sits idle for weeks between steps, so an age rule
 * that ignored status would delete journeys mid-flight and strand the person
 * halfway through a sequence.
 */
export async function pruneJourneyTraces(): Promise<RetentionResult> {
  const eventCutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const runCutoff = new Date(Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Events are self-contained: once processed they are a record of a decision,
  // and the runs they produced carry their own history.
  const { count: events } = await prisma.journeyEvent.deleteMany({
    where: { createdAt: { lt: eventCutoff }, status: { in: ["processed", "failed"] } },
  });

  // Per-journey floor first: work out which old runs are protected by being
  // among the most recent for their journey, then delete the rest.
  const journeys = await prisma.journey.findMany({ select: { id: true } });
  const protectedIds = new Set<string>();
  for (const journey of journeys) {
    const recent = await prisma.journeyRun.findMany({
      where: { journeyId: journey.id },
      orderBy: { createdAt: "desc" },
      take: RUNS_KEPT_PER_JOURNEY,
      select: { id: true },
    });
    for (const run of recent) protectedIds.add(run.id);
  }

  const stale = await prisma.journeyRun.findMany({
    where: {
      createdAt: { lt: runCutoff },
      // Closed only. `queued`, `running`, `waiting` and `blocked` are live state
      // — a waiting run can sit idle for weeks by design.
      status: { in: ["completed", "failed", "cancelled"] },
      id: { notIn: [...protectedIds] },
    },
    take: MAX_DELETES_PER_SWEEP,
    select: { id: true },
  });
  if (stale.length === 0) return { events, runs: 0 };

  // Step logs cascade from JourneyRun (onDelete: Cascade), so deleting the run
  // takes its whole timeline with it — no orphaned rows to sweep separately.
  const { count: runs } = await prisma.journeyRun.deleteMany({
    where: { id: { in: stale.map((run) => run.id) } },
  });
  return { events, runs };
}
