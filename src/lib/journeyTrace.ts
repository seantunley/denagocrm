import "server-only";
import { prisma } from "./db";
import { JOURNEY_TRIGGERS } from "./journeyTypes";
import type { JourneyEnrolmentDecision } from "./journeyEvents";

/**
 * The activity trace for a journey: what fired, what it decided, and what each
 * run actually did.
 *
 * Modelled on Home Assistant's automation traces, and for the same reason. The
 * engine already recorded events, runs and step logs; nothing showed them, so
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

export type TraceRun = {
  id: string;
  status: string;
  entityType: string;
  entityId: string;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  steps: {
    stepId: string;
    stepType: string;
    status: string;
    note: string | null;
    startedAt: Date;
    completedAt: Date | null;
    /** Milliseconds the step took, or null while it is still running. */
    durationMs: number | null;
  }[];
};

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
    steps: run.stepLogs.map((log) => ({
      stepId: log.stepId,
      stepType: log.stepType,
      status: log.status,
      note: log.note,
      startedAt: log.startedAt,
      completedAt: log.completedAt,
      durationMs: log.completedAt ? log.completedAt.getTime() - log.startedAt.getTime() : null,
    })),
  }));
}
