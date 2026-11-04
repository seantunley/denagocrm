import "server-only";
import { prisma } from "./db";
import { enqueueJourneyRun, getActiveVersion, REFUSAL_REASONS } from "./journeyEngineShared";
import { journeyTenantId } from "./journeyTenant";
import type { JourneyEntityType } from "./journeyContext";
import { JOURNEY_LIMITS } from "./journeyTypes";
import { handedOverVars } from "./journeyVariables";

const followUpLabel = (minutes: number) =>
  minutes % 1440 === 0 ? `${minutes / 1440} day${minutes === 1440 ? "" : "s"}` : minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minute${minutes === 1 ? "" : "s"}`;

export type DirectJourneyEnrolment = {
  ok: boolean;
  runId?: string;
  reason: string;
};

/**
 * Explicitly enrol ONE already-owned CRM entity into ONE active Journey.
 *
 * This is intentionally not `enrollJourneyNow()`: that function schedules a
 * Journey's configured trigger and may sweep many records. A chatbot Start
 * Journey node already names the journey and the current customer, so it should
 * create exactly one run through the existing Journey arbitration/runner.
 *
 * The `eventKey` comes from the chatbot's retry-stable inbound-event + node
 * identity. `enqueueJourneyRun` hashes it with journey/version/entity and handles
 * duplicate-event/run-mode arbitration under the existing enrolment lock.
 */
export async function enrollEntityInJourney(input: {
  journeyId: string;
  entityType: JourneyEntityType;
  entityId: string;
  eventKey: string;
  payload?: Record<string, unknown>;
  /** A follow-up: minutes until the first step is due (capped at 30 days), and saved answers handed over as variables. */
  delayMinutes?: number;
  handOver?: Record<string, string>;
}): Promise<DirectJourneyEnrolment> {
  const tenantId = journeyTenantId();
  const journey = await prisma.journey.findFirst({
    where: { id: input.journeyId, tenantId, status: "active" },
    include: { versions: { where: { tenantId, state: "published" } } },
  });
  if (!journey) return { ok: false, reason: "Journey is not active" };
  const version = getActiveVersion(journey);
  if (!version) return { ok: false, reason: "Journey has no published active version" };

  // Explicit ownership check even when tenancy enforcement is dormant.
  const owned = input.entityType === "lead"
    ? await prisma.lead.findFirst({ where: { id: input.entityId, tenantId }, select: { id: true } })
    : await prisma.contact.findFirst({ where: { id: input.entityId, tenantId }, select: { id: true } });
  if (!owned) return { ok: false, reason: "Customer record not found in this workspace" };

  const delayMinutes = Math.min(Math.max(0, Math.round(input.delayMinutes ?? 0)), JOURNEY_LIMITS.waitDays * 1440);
  const outcome = await enqueueJourneyRun({
    journey,
    version,
    entityType: input.entityType,
    entityId: input.entityId,
    eventKey: input.eventKey,
    payload: {
      ...(input.payload ?? {}),
      type: "chatbot_start",
      source: "chatbot",
    },
    ...(delayMinutes ? { startAt: new Date(Date.now() + delayMinutes * 60_000) } : {}),
    vars: handedOverVars(input.handOver ?? {}),
  });
  if (outcome.enrolled) {
    return {
      ok: true,
      runId: outcome.runId,
      reason: outcome.status === "blocked" ? "queued behind an existing run" : delayMinutes ? `enrolled — starts in ${followUpLabel(delayMinutes)}` : "enrolled",
    };
  }
  // A retry of the same chatbot event is business success: the run already
  // exists and must not be treated as a failed customer flow step.
  if (outcome.refusal === "duplicate_event") return { ok: true, reason: "already enrolled for this event" };
  return { ok: false, reason: REFUSAL_REASONS[outcome.refusal] };
}
