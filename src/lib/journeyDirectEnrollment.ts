import "server-only";
import { prisma } from "./db";
import { enqueueJourneyRun, getActiveVersion, REFUSAL_REASONS } from "./journeyEngineShared";
import { journeyTenantId } from "./journeyTenant";
import type { JourneyEntityType } from "./journeyContext";

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
  });
  if (outcome.enrolled) {
    return {
      ok: true,
      runId: outcome.runId,
      reason: outcome.status === "blocked" ? "queued behind an existing run" : "enrolled",
    };
  }
  // A retry of the same chatbot event is business success: the run already
  // exists and must not be treated as a failed customer flow step.
  if (outcome.refusal === "duplicate_event") return { ok: true, reason: "already enrolled for this event" };
  return { ok: false, reason: REFUSAL_REASONS[outcome.refusal] };
}
