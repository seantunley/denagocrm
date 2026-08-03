import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { activeTenantPredicate } from "./tenantPredicate";

/**
 * Deciding what a second enrolment means, ATOMICALLY.
 *
 * The decision reads the open runs for one person on one journey and then
 * writes — cancelling, parking or creating. Read-then-write across two
 * statements is a race, and every run mode has its own way of losing it:
 *
 *   single    two enrolments both see no open run; both create. Two live
 *             sequences on a mode whose entire promise is "only one".
 *   restart   both cancel the same predecessor and both create a replacement.
 *   queued    both park behind the same predecessor, and the release sweep then
 *             hands both back at once — the queue delivers in parallel.
 *   cap       ten enrolments in flight all read nine and all proceed.
 *
 * None of these is exotic: an event burst on one lead is the ordinary case, and
 * `processJourneyEvents` walks a batch with no gap between the reads.
 *
 * ── Why this cannot use `prisma.$transaction` ────────────────────────────────
 *
 * The exported `prisma` client wraps every model op in its OWN array
 * transaction (`withRlsScope` → `client.$transaction([setGuc, op])`) against the
 * TOP-LEVEL client, not against whatever `tx` handle it is called on. So inside
 * `prisma.$transaction(async (tx) => …)`, `tx.journeyRun.findMany()` escapes to
 * a different pooled connection — see the note in lib/db.ts, which records this
 * as a defect already fixed once. An advisory lock taken on the callback's
 * connection would guard nothing, and the reads would sit outside the
 * transaction entirely.
 *
 * `basePrisma.$transaction(async (tx) => …)` runs the callback on the RAW `tx`
 * with bypass set once at the top, so the lock and the statements genuinely
 * share one connection. The price is that the RLS extension is bypassed, which
 * is why every query below carries `activeTenantPredicate()` explicitly. That
 * is the same trade lib/trash.ts and lib/permissions.ts already make.
 */

/**
 * The advisory-lock key for one person on one journey.
 *
 * 60 bits of a sha256, so it is deterministic across processes and always
 * positive — `pg_advisory_xact_lock` takes a signed bigint, and a key built
 * from the full 64 bits would overflow for half of all inputs.
 */
export function enrolmentLockKey(journeyId: string, entityType: string, entityId: string): bigint {
  const digest = crypto.createHash("sha256").update(`${journeyId}:${entityType}:${entityId}`).digest("hex");
  return BigInt(`0x${digest.slice(0, 15)}`);
}

/**
 * Serialise everything that decides whether a run may start, for one person on
 * one journey.
 *
 * `pg_advisory_xact_lock` rather than `SELECT … FOR UPDATE`: the thing being
 * serialised is partly the ABSENCE of rows ("nobody has an open run"), and row
 * locks cannot lock a row that is not there. Two enrolments arriving at an
 * entity with no open runs would lock nothing and both proceed. The lock is
 * transaction-scoped, so it is released on commit or rollback with no unlock
 * path to forget.
 *
 * Different journeys, and different people on the same journey, take different
 * keys and do not contend.
 */
export async function withEnrolmentLock<T>(
  journeyId: string,
  entityType: string,
  entityId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const key = enrolmentLockKey(journeyId, entityType, entityId);
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;
    return fn(tx);
  });
}

/** Runs that have not finished — the ones a re-enrolment has to reckon with. */
export const OPEN_RUN_STATUSES = ["queued", "running", "waiting", "blocked"];

/**
 * How many runs one person may have open on one journey before further
 * enrolments are dropped.
 *
 * Home Assistant caps this too (`max`, default 10) and it is not decoration: a
 * "queued" journey with no ceiling is an unbounded queue. A lead whose stage
 * changes twenty times in an afternoon would park twenty runs, and they would
 * then drain one after another and send twenty times — days after the activity
 * that caused them.
 */
export const MAX_OPEN_RUNS_PER_ENTITY = 10;

export type JourneyRunMode = "single" | "restart" | "queued" | "parallel";

export function parseRunMode(value: unknown): JourneyRunMode {
  return value === "restart" || value === "queued" || value === "parallel" ? value : "single";
}

/**
 * Why an enrolment did not produce a run.
 *
 * A discriminated reason rather than a boolean, because these are genuinely
 * different events and the trace exists to tell them apart. `false` for all of
 * them is what made a cap refusal, a single-mode drop and a real duplicate all
 * read as "already enrolled for this event" — which reads as the engine
 * working when it is in fact refusing.
 */
export type EnrolmentRefusal =
  | "entity_missing"
  | "entry_conditions"
  | "no_steps"
  | "cap_reached"
  | "single_open"
  | "duplicate_event";

export const REFUSAL_REASONS: Record<EnrolmentRefusal, string> = {
  entity_missing: "the lead or contact no longer exists",
  entry_conditions: "entry conditions did not match",
  no_steps: "the published version has no first step",
  cap_reached: `already has ${MAX_OPEN_RUNS_PER_ENTITY} open runs (the per-person cap)`,
  single_open: "a run is already open and this journey is set to “single”",
  duplicate_event: "already enrolled for this event",
};

export type ArbitrationOutcome =
  | { action: "proceed" }
  | { action: "drop"; refusal: EnrolmentRefusal }
  | { action: "wait"; afterRunId: string };

/**
 * Apply the run mode. MUST be called inside `withEnrolmentLock` — it reads the
 * open runs and, for `restart`, writes.
 */
export async function arbitrateEnrolment(
  tx: Prisma.TransactionClient,
  journeyId: string,
  entityType: string,
  entityId: string,
  mode: JourneyRunMode,
): Promise<ArbitrationOutcome> {
  const tenant = activeTenantPredicate("arbitrateEnrolment");
  // The cap applies to EVERY mode including parallel — parallel is the one that
  // piles up fastest, since it never consults the open runs at all.
  const openRuns = await tx.journeyRun.findMany({
    where: { ...tenant, journeyId, entityType, entityId, status: { in: OPEN_RUN_STATUSES } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (openRuns.length >= MAX_OPEN_RUNS_PER_ENTITY) return { action: "drop", refusal: "cap_reached" };
  if (mode === "parallel") return { action: "proceed" };
  const open = openRuns[0];
  if (!open) return { action: "proceed" };
  if (mode === "single") return { action: "drop", refusal: "single_open" };
  if (mode === "queued") return { action: "wait", afterRunId: open.id };

  // restart: retire EVERY open run, not just the newest. Cancelling one of
  // several would leave the older ones running beside the replacement, which is
  // the opposite of what the mode promises — and multiples are reachable
  // through a journey that ran as `parallel` before its mode was changed.
  await tx.journeyRun.updateMany({
    where: { ...tenant, id: { in: openRuns.map((run) => run.id) }, status: { in: OPEN_RUN_STATUSES } },
    data: {
      status: "cancelled",
      completedAt: new Date(),
      lastError: "Superseded by a newer enrolment (run mode: restart)",
    },
  });
  return { action: "proceed" };
}
