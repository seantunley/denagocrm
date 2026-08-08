import "server-only";
import { prisma } from "./db";
import { JOURNEY_TRIGGERS } from "./journeyTypes";
import { cursorPath, parseCursor } from "./journeyCursor";
import { parseClauses, parseItemCount, parseTimestamp, type TraceStep } from "./journeyTraceTree";
import type { JourneyEnrolmentDecision } from "./journeyEvents";

/**
 * The activity trace for a journey: what fired, what it decided, and what each
 * run actually did.
 *
 * The engine already recorded events, runs and step logs; nothing showed them, so
 * an automation that never ran was indistinguishable from one that ran and
 * matched nobody. That is not a hypothetical — journeys built on event triggers
 * enrolled nobody for months because `emitJourneyEvent` was never called from
 * any write path, and the only symptom was silence.
 *
 * The headline number here is deliberately "events seen for this trigger". Zero
 * is the answer that identifies a broken wiring, and it is the one a run list
 * can never give you.
 */

export type TriggerHealth = {
  trigger: string;
  /** Events of this type recorded in the window, across all journeys. */
  events: number;
  /** Whether ANY event of this type has EVER been recorded. */
  everSeen: boolean;
};

export type TraceEvent = {
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  status: string;
  error: string | null;
  createdAt: Date;
  processedAt: Date | null;
  /** Null for events recorded before tracing existed — not "nothing considered". */
  decisions: JourneyEnrolmentDecision[] | null;
};

/**
 * A run's step timeline.
 *
 * `steps` is a FLAT list carrying the hierarchical path. For a flat journey the
 * path is identical to the step id —
 * which is why every trace written before nesting existed still reads
 * correctly. Inside a container it names the branch and the ITERATION, so
 * `blast/repeat/2/sequence/1` and `blast/repeat/0/sequence/1` are
 * distinguishable, which flat step ids never were. `buildTraceTree` in
 * journeyTraceTree.ts is what turns the list back into the tree it describes.
 */
export type TraceRun = {
  id: string;
  status: string;
  entityType: string;
  entityId: string;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  steps: TraceStep[];
};

/** One run's trace, with everything needed to draw the branches NOT taken. */
export type TraceRunDetail = TraceRun & {
  journeyId: string;
  journeyName: string;
  journeyCategory: string;
  version: number;
  leadId: string | null;
  contactId: string | null;
  /**
   * The PINNED definition this run is executing. A run holds its version for
   * life, so the choose options and repeat bodies here are the ones it actually
   * saw — not whatever the journey has been edited into since.
   */
  definition: unknown;
  /**
   * Where the run is parked right now, as a trace path; null once it is done.
   * This is the live head of an in-flight run — the step it is ABOUT to take,
   * which no step log can show because it has not happened yet.
   */
  cursorPath: string | null;
  nextRunAt: Date;
  attempts: number;
  stepsExecuted: number;
  createdAt: Date;
};

/** A run as it appears in the picker above the trace. */
export type TraceRunSummary = {
  id: string;
  journeyId: string;
  journeyName: string;
  status: string;
  entityType: string;
  leadId: string | null;
  contactId: string | null;
  steps: number;
  createdAt: Date;
  lastError: string | null;
};

/** A step log row in the shape the tree builder wants. */
function toTraceStep(log: {
  path: string;
  stepId: string;
  stepType: string;
  status: string;
  note: string | null;
  output: unknown;
  startedAt: Date;
  completedAt: Date | null;
}): TraceStep {
  return {
    path: log.path,
    stepId: log.stepId,
    stepType: log.stepType,
    status: log.status,
    note: log.note,
    startedAt: log.startedAt,
    completedAt: log.completedAt,
    durationMs: log.completedAt ? log.completedAt.getTime() - log.startedAt.getTime() : null,
    clauses: parseClauses(log.output),
    // A step HELD for retry (quiet hours, a frequency cap) writes status
    // "running" with the time it will be tried again. That is what separates it
    // from the row written a moment before a step is actually attempted, which
    // carries no output at all.
    nextRunAt: parseTimestamp(
      log.output && typeof log.output === "object" && !Array.isArray(log.output)
        ? (log.output as Record<string, unknown>).nextRunAt
        : undefined,
    ),
    plannedIterations: parseItemCount(log.output),
  };
}

function parseDecisions(value: unknown): JourneyEnrolmentDecision[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.journeyId !== "string" || typeof row.reason !== "string") return [];
    return [{
      journeyId: row.journeyId,
      journeyName: typeof row.journeyName === "string" ? row.journeyName : "Journey",
      enrolled: row.enrolled === true,
      reason: row.reason,
    }];
  });
}

/**
 * Which triggers have ever actually fired.
 *
 * A trigger the builder OFFERS but nothing emits is a trap: you configure it,
 * activate it, and nothing happens with no error. `everSeen: false` is that
 * trap, made visible.
 */
export async function triggerHealth(sinceDays = 30): Promise<TriggerHealth[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const [recent, ever] = await Promise.all([
    prisma.journeyEvent.groupBy({
      by: ["type"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.journeyEvent.groupBy({ by: ["type"], _count: { _all: true } }),
  ]);
  const recentByType = new Map(recent.map((row) => [row.type, row._count._all]));
  const everByType = new Set(ever.map((row) => row.type));
  return JOURNEY_TRIGGERS.map((trigger) => ({
    trigger,
    events: recentByType.get(trigger) ?? 0,
    everSeen: everByType.has(trigger),
  }));
}

/** Recent events, with the enrolment decision made for each journey. */
export async function recentTraceEvents(opts: { journeyId?: string; limit?: number } = {}): Promise<TraceEvent[]> {
  const rows = await prisma.journeyEvent.findMany({
    // An event with no journeyId was broadcast to every active journey, so it
    // belongs in a single journey's trace too — its decisions name that journey.
    where: opts.journeyId ? { OR: [{ journeyId: opts.journeyId }, { journeyId: null }] } : {},
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 50, 200),
  });
  const events = rows.map((row) => ({
    id: row.id,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    processedAt: row.processedAt,
    decisions: parseDecisions(row.decisions),
  }));
  if (!opts.journeyId) return events;
  // Keep a broadcast event only when THIS journey was actually weighed on it.
  return events.filter(
    (event) => event.decisions === null || event.decisions.some((d) => d.journeyId === opts.journeyId),
  );
}

/** Recent runs with their step timeline — the "what did it actually do" half. */
export async function recentTraceRuns(journeyId: string, limit = 25): Promise<TraceRun[]> {
  const runs = await prisma.journeyRun.findMany({
    where: { journeyId },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 100),
    include: { stepLogs: { orderBy: { startedAt: "asc" } } },
  });
  return runs.map((run) => ({
    id: run.id,
    status: run.status,
    entityType: run.entityType,
    entityId: run.entityId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    lastError: run.lastError,
    steps: run.stepLogs.map(toTraceStep),
  }));
}

/**
 * The runs that can be traced, newest first.
 *
 * Every query in this module goes through the FILTERED `prisma` client, whose
 * extension adds the active tenant to the where clause (and to the
 * extendedWhereUnique of a findUnique). No raw SQL: `$queryRaw`/`$executeRaw`
 * bypass that extension outright, and a trace exposes lead and contact ids of
 * whoever the run enrolled.
 */
export async function recentRunSummaries(limit = 30): Promise<TraceRunSummary[]> {
  const runs = await prisma.journeyRun.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 100),
    select: {
      id: true,
      journeyId: true,
      status: true,
      entityType: true,
      leadId: true,
      contactId: true,
      createdAt: true,
      lastError: true,
      journey: { select: { name: true } },
      _count: { select: { stepLogs: true } },
    },
  });
  return runs.map((run) => ({
    id: run.id,
    journeyId: run.journeyId,
    journeyName: run.journey.name,
    status: run.status,
    entityType: run.entityType,
    leadId: run.leadId,
    contactId: run.contactId,
    steps: run._count.stepLogs,
    createdAt: run.createdAt,
    lastError: run.lastError,
  }));
}

/**
 * One run's full trace: every execution, plus the definition it was executing.
 *
 * The definition comes from the run's PINNED version rather than the journey's
 * current one. Traces are read after the fact, often after the journey has been
 * edited, and drawing "which branch was taken" against a definition the run
 * never saw would put the highlight on the wrong branch — silently, and most
 * convincingly on the journey that has just been changed to fix the problem.
 */
export async function traceRun(runId: string): Promise<TraceRunDetail | null> {
  const run = await prisma.journeyRun.findUnique({
    where: { id: runId },
    include: {
      journey: { select: { id: true, name: true, category: true } },
      journeyVersion: { select: { version: true, definition: true } },
      stepLogs: { orderBy: { startedAt: "asc" } },
    },
  });
  if (!run) return null;

  // The cursor is where the run WILL go next. A finished run has none — the
  // column is cleared on completion — and a run that predates nesting stores
  // only currentStepId, which parseCursor reads as a flat position.
  const cursor = parseCursor(run.cursor, run.currentStepId);
  return {
    id: run.id,
    status: run.status,
    entityType: run.entityType,
    entityId: run.entityId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    lastError: run.lastError,
    steps: run.stepLogs.map(toTraceStep),
    journeyId: run.journey.id,
    journeyName: run.journey.name,
    journeyCategory: run.journey.category,
    version: run.journeyVersion.version,
    leadId: run.leadId,
    contactId: run.contactId,
    definition: run.journeyVersion.definition,
    cursorPath: cursor.stepId ? cursorPath(cursor) : null,
    nextRunAt: run.nextRunAt,
    attempts: run.attempts,
    stepsExecuted: run.stepsExecuted,
    createdAt: run.createdAt,
  };
}
