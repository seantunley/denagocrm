import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { evaluateConditions, parseConditionGroup, parseJourneyDefinition } from "./journeyTypes";
import { loadJourneyContext, type JourneyEntityType } from "./journeyContext";
import {
  arbitrateEnrolment,
  parseRunMode,
  withEnrolmentLock,
  type EnrolmentRefusal,
} from "./journeyArbitration";
import { inheritedTenantId } from "./tenantWrite";

export {
  MAX_OPEN_RUNS_PER_ENTITY,
  parseRunMode,
  REFUSAL_REASONS,
  type EnrolmentRefusal,
  type JourneyRunMode,
} from "./journeyArbitration";

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

/**
 * What an enrolment attempt did.
 *
 * This replaced a bare boolean. `false` was returned for a missing entity, an
 * entry-condition mismatch, a definition with no steps, a cap refusal, a
 * single-mode drop AND a genuine duplicate — six different events, all of which
 * the activity trace then reported as "already enrolled for this event". The
 * trace exists precisely to tell those apart, and it could not.
 */
export type EnrolmentResult =
  | { enrolled: true; runId: string; status: "queued" | "blocked" }
  | { enrolled: false; refusal: EnrolmentRefusal };

export async function enqueueJourneyRun(args: {
  /**
   * `tenantId` is REQUIRED in this shape, and it is the reason the enrolment can
   * be owned at all. Both callers already load the journey with an explicit
   * `where: { tenantId }`, so the field is free — but declaring it means a third
   * caller cannot enrol somebody into a journey without having established whose
   * journey it is.
   */
  journey: { id: string; name: string; category: string; runMode?: string | null; tenantId: string | null };
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
}): Promise<EnrolmentResult> {
  const context = await loadJourneyContext(args.entityType, args.entityId, args.payload);
  if (!context) return { enrolled: false, refusal: "entity_missing" };
  const conditions = parseConditionGroup(args.version.entryConditions);
  if (!evaluateConditions(conditions, context)) return { enrolled: false, refusal: "entry_conditions" };
  const definition = parseJourneyDefinition(args.version.definition);
  if (!definition.startStepId) return { enrolled: false, refusal: "no_steps" };
  const lead = (context.lead ?? {}) as Record<string, unknown>;
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  const idempotencyKey = hashJourneyKey(
    `${args.journey.id}:${args.version.version}:${args.eventKey}:${args.entityType}:${args.entityId}`
  );

  // The run mode decides what a SECOND live enrolment means. The idempotency key
  // above only stops a repeat of the same event; it has never had anything to
  // say about a different event reaching the same person.
  //
  // Arbitration and creation are ONE transaction under a per-(journey, entity)
  // advisory lock. Split apart they are a read-then-write race in which every
  // mode loses differently — two "single" runs, a doubled restart, a cap that
  // admits eleven. See journeyArbitration.ts for why this cannot go through the
  // extended `prisma` client.
  const mode = parseRunMode(args.journey.runMode);
  // THE JOURNEY OWNS THE RUN.
  //
  // This used to be `activeTenantPredicate("enqueueJourneyRun")`, which returns
  // `{}` — no tenantId at all — whenever enforcement is not on. Enforcement is
  // not on anywhere, so the spread contributed nothing and every JourneyRun ever
  // created landed with a NULL tenant: 6 of 6 on production at the 2026-08-10
  // audit. The comment below was already correct about what had to happen; the
  // value it was given could not do it.
  //
  // `inheritedTenantId` still evaluates `writeTenantId()` first, so the
  // fail-closed throw for "enforcing with no usable scope" is preserved, and
  // under enforcement the scope still wins over the row. Both callers resolve
  // `journey` inside their own tenant, so the two agree by construction.
  const runTenantId = inheritedTenantId(args.journey.tenantId);
  try {
    return await withEnrolmentLock(args.journey.id, args.entityType, args.entityId, async (tx) => {
      // THE DUPLICATE IS CHECKED, NOT CAUGHT.
      //
      // Catching P2002 from the insert and carrying on does not work inside a
      // transaction: Postgres marks the whole transaction aborted the moment a
      // statement fails, so every later statement errors with "current
      // transaction is aborted" and the COMMIT fails too. The handler would
      // return `duplicate_event` and then the commit would throw on the way
      // out, turning an ordinary repeat event into a failed one — and, because
      // the event processor retries, into three of them.
      //
      // A read is safe here where it would not be outside: the advisory lock
      // serialises every enrolment for this (journey, entity), and the same
      // event on the same person always hashes to the same key, so nothing can
      // insert between this check and the insert below.

      const existing = await tx.journeyRun.findUnique({
        where: { idempotencyKey },
        select: { id: true },
      });
      if (existing) return { enrolled: false as const, refusal: "duplicate_event" as const };

      const against = await arbitrateEnrolment(tx, args.journey.id, args.entityType, args.entityId, mode);
      if (against.action === "drop") return { enrolled: false as const, refusal: against.refusal };

      const run = await tx.journeyRun.create({
        data: {
          // The lock transaction runs on basePrisma, which bypasses the tenant
          // extension — so the tenant that scoping would have supplied has to be
          // written explicitly, or the run lands with a null tenant and becomes
          // invisible to the very workspace that created it.
          tenantId: runTenantId,
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
        select: { id: true, status: true },
      });
      return {
        enrolled: true as const,
        runId: run.id,
        status: run.status as "queued" | "blocked",
      };
    });
  } catch (error) {
    // Backstop, and deliberately OUTSIDE the transaction. The pre-check plus the
    // advisory lock should make this unreachable; if it ever fires, the
    // transaction has already rolled back, so reporting a duplicate from here is
    // safe in the way reporting it from inside was not.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { enrolled: false, refusal: "duplicate_event" };
    }
    throw error;
  }
}
