import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { evaluateConditions, parseConditionGroup, parseJourneyDefinition } from "./journeyTypes";
import { loadJourneyContext, type JourneyEntityType } from "./journeyContext";

export const hashJourneyKey = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

export const jsonObject = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export function getActiveVersion<T extends { version: number }>(journey: {
  activeVersion: number | null;
  versions: T[];
}): T | null {
  return journey.versions.find((version) => version.version === journey.activeVersion) ?? null;
}

/** Runs that have not finished — the ones a re-enrolment has to reckon with. */
const OPEN_RUN_STATUSES = ["queued", "running", "waiting", "blocked"];

/**
 * How many runs one person may have open on one journey before further
 * enrolments are dropped.
 *
 * Home Assistant caps this too (`max`, default 10) and it is not decoration: a
 * "queued" journey with no ceiling is an unbounded queue. A lead whose stage
 * changes twenty times in an afternoon would park twenty runs, and they would
 * then drain one after another and send twenty times — days after the activity
 * that caused them.
 *
 * Fixed rather than per-journey, unlike HA's: a configurable ceiling is a knob
 * nobody sets correctly without first hitting the problem, and the trace now
 * shows when the cap bites. Worth revisiting if a real journey needs more.
 */
const MAX_OPEN_RUNS_PER_ENTITY = 10;

export type JourneyRunMode = "single" | "restart" | "queued" | "parallel";

export function parseRunMode(value: unknown): JourneyRunMode {
  return value === "restart" || value === "queued" || value === "parallel" ? value : "single";
}

/**
 * Apply the journey's run mode to a re-enrolment.
 *
 * Returns the run this enrolment should BLOCK on, `"drop"` to abandon it, or
 * null to proceed normally.
 *
 * There was one implicit answer before this: the idempotency key made a repeat
 * of the SAME event a no-op, but a different event on the same person started a
 * second run — silently — and both sequences then sent. That is right for a few
 * journeys and wrong for most, and nobody could choose.
 */
async function resolveAgainstOpenRuns(
  journeyId: string,
  entityType: JourneyEntityType,
  entityId: string,
  mode: JourneyRunMode,
): Promise<{ action: "proceed" } | { action: "drop" } | { action: "wait"; afterRunId: string }> {
  // The cap applies to EVERY mode including parallel — parallel is the one that
  // piles up fastest, since it never consults the open runs at all.
  const openRuns = await prisma.journeyRun.findMany({
    where: { journeyId, entityType, entityId, status: { in: OPEN_RUN_STATUSES } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (openRuns.length >= MAX_OPEN_RUNS_PER_ENTITY) return { action: "drop" };
  if (mode === "parallel") return { action: "proceed" };
  const open = openRuns[0];
  if (!open) return { action: "proceed" };
  if (mode === "single") return { action: "drop" };
  if (mode === "queued") return { action: "wait", afterRunId: open.id };
  // restart: the newest enrolment is the one that matters, so retire the open
  // run rather than leaving two live sequences for the same person. Conditional
  // on it still being open — it may have completed while we were deciding.
  await prisma.journeyRun.updateMany({
    where: { id: open.id, status: { in: OPEN_RUN_STATUSES } },
    data: { status: "cancelled", completedAt: new Date(), lastError: "Superseded by a newer enrolment (run mode: restart)" },
  });
  return { action: "proceed" };
}

export async function enqueueJourneyRun(args: {
  journey: { id: string; name: string; category: string; runMode?: string | null };
  version: {
    id: string;
    version: number;
    entryConditions: Prisma.JsonValue | null;
    definition: Prisma.JsonValue;
  };
  entityType: JourneyEntityType;
  entityId: string;
  eventKey: string;
  payload: Record<string, unknown>;
}) {
  const context = await loadJourneyContext(args.entityType, args.entityId, args.payload);
  if (!context) return false;
  const conditions = parseConditionGroup(args.version.entryConditions);
  if (!evaluateConditions(conditions, context)) return false;
  const definition = parseJourneyDefinition(args.version.definition);
  if (!definition.startStepId) return false;
  const lead = (context.lead ?? {}) as Record<string, unknown>;
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  const idempotencyKey = hashJourneyKey(
    `${args.journey.id}:${args.version.version}:${args.eventKey}:${args.entityType}:${args.entityId}`
  );

  // The run mode decides what a SECOND live enrolment means. The idempotency key
  // above only stops a repeat of the same event; it has never had anything to
  // say about a different event reaching the same person.
  const mode = parseRunMode(args.journey.runMode);
  const against = await resolveAgainstOpenRuns(args.journey.id, args.entityType, args.entityId, mode);
  if (against.action === "drop") return false;

  try {
    await prisma.journeyRun.create({
      data: {
        journeyId: args.journey.id,
        journeyVersionId: args.version.id,
        entityType: args.entityType,
        entityId: args.entityId,
        leadId: typeof lead.id === "string" ? lead.id : null,
        contactId: typeof contact.id === "string" ? contact.id : null,
        currentStepId: definition.startStepId,
        context: context as Prisma.InputJsonValue,
        idempotencyKey,
        // "queued" holds the new run until the open one finishes. Parked as
        // `blocked` rather than given a future nextRunAt: a guessed delay either
        // starts it while the first is still going, or leaves it idle long after
        // that one ended. The sweep releases it when the predecessor actually
        // closes.
        ...(against.action === "wait"
          ? { status: "blocked", blockedByRunId: against.afterRunId }
          : {}),
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}
