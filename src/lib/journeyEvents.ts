import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { loadJourneyContext, type JourneyEntityType } from "./journeyContext";
import {
  enqueueJourneyRun,
  getActiveVersion,
  hashJourneyKey,
  jsonObject,
} from "./journeyEngineShared";
import { NEVER_STOP, type StopSignal } from "./stopSignal";

/** One event can enrol into several journeys, each of which may send. */
const EVENT_RESERVE_MS = 4_000;

/**
 * One journey's verdict on one event, as shown in the activity trace.
 *
 * `enrolled: false` is the interesting case and it has several distinct causes
 * — the reason string is what tells them apart, so never collapse them.
 */
export type JourneyEnrolmentDecision = {
  journeyId: string;
  journeyName: string;
  enrolled: boolean;
  reason: string;
};

const MAX_EVENT_ATTEMPTS = 3;

export async function emitJourneyEvent(args: {
  type: string;
  entityType: JourneyEntityType;
  entityId: string;
  payload?: Record<string, unknown>;
  dedupeKey: string;
  journeyId?: string;
}) {
  try {
    return await prisma.journeyEvent.create({
      data: {
        type: args.type,
        entityType: args.entityType,
        entityId: args.entityId,
        payload: (args.payload ?? {}) as Prisma.InputJsonValue,
        dedupeKey: hashJourneyKey(args.dedupeKey),
        journeyId: args.journeyId,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}

function triggerMatches(
  trigger: string,
  config: Record<string, unknown>,
  context: Awaited<ReturnType<typeof loadJourneyContext>>,
  payload: Record<string, unknown> = {}
) {
  if (!context) return false;
  if (trigger === "stage_entered") {
    const lead = (context.lead ?? {}) as Record<string, unknown>;
    // Prefer the stage recorded ON THE EVENT over the lead's stage now. Events
    // are drained by a cron that runs every 15 minutes, so a rep who moves a
    // lead Qualified → Quoted inside that window would otherwise have the
    // Qualified event judged against "Quoted" and silently match nothing.
    const entered = typeof payload.stageId === "string" ? payload.stageId : lead.stageId;
    return !config.stageId || config.stageId === entered;
  }
  return true;
}

export async function recoverStaleJourneyEvents() {
  const cutoff = new Date(Date.now() - 15 * 60_000);
  return prisma.journeyEvent.updateMany({
    where: { status: "processing", updatedAt: { lt: cutoff } },
    data: { status: "pending", availableAt: new Date(), error: "Recovered stale processing event" },
  });
}

export async function processJourneyEvents(limit = 50, stop: StopSignal = NEVER_STOP) {
  const events = await prisma.journeyEvent.findMany({
    where: { status: "pending", availableAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let enrolled = 0;

  for (const event of events) {
    if (stop.shouldStop(EVENT_RESERVE_MS)) break;
    const claimed = await prisma.journeyEvent.updateMany({
      where: { id: event.id, status: "pending" },
      data: { status: "processing", attempts: { increment: 1 }, error: null },
    });
    if (claimed.count === 0) continue;

    try {
      const journeys = await prisma.journey.findMany({
        where: {
          status: "active",
          ...(event.journeyId ? { id: event.journeyId } : {}),
        },
        include: { versions: { where: { state: "published" } } },
      });
      const payload = jsonObject(event.payload);
      const eventPayload = { ...payload, type: event.type };
      const context = await loadJourneyContext(
        event.entityType as JourneyEntityType,
        event.entityId,
        eventPayload
      );
      if (!context) throw new Error("Journey event entity no longer exists");

      // Every journey considered, and why it did or did not enrol. This loop
      // used to be bare `continue`s: a journey nobody emits for looked exactly
      // like a journey nobody matched, which is how "New lead created"
      // journeys sat active enrolling nobody with nothing on screen to say so.
      const decisions: JourneyEnrolmentDecision[] = [];

      for (const journey of journeys) {
        const version = getActiveVersion(journey);
        if (!version) {
          decisions.push({ journeyId: journey.id, journeyName: journey.name, enrolled: false, reason: "no published version" });
          continue;
        }
        if (version.trigger !== event.type) {
          decisions.push({
            journeyId: journey.id,
            journeyName: journey.name,
            enrolled: false,
            reason: `listens for "${version.trigger}", not "${event.type}"`,
          });
          continue;
        }
        // eventPayload, not just the context: a stage_entered event carries the
        // stage the lead ENTERED, and the cron drains up to 15 minutes later —
        // judging against the lead's stage now would silently match nothing for
        // anyone who moved the card again inside that window.
        if (!triggerMatches(version.trigger, jsonObject(version.triggerConfig), context, eventPayload)) {
          decisions.push({ journeyId: journey.id, journeyName: journey.name, enrolled: false, reason: "trigger filters did not match" });
          continue;
        }
        const queued = await enqueueJourneyRun({
          journey,
          version,
          entityType: event.entityType as JourneyEntityType,
          entityId: event.entityId,
          eventKey: event.dedupeKey,
          payload: eventPayload,
        });
        if (queued) enrolled++;
        decisions.push({
          journeyId: journey.id,
          journeyName: journey.name,
          enrolled: queued,
          // A false here is not a mismatch — it is the idempotency key doing its
          // job, which reads as a bug unless it is spelled out.
          reason: queued ? "enrolled" : "already enrolled for this event",
        });
      }

      await prisma.journeyEvent.update({
        where: { id: event.id },
        data: { status: "processed", processedAt: new Date(), decisions },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown journey event error";
      const retry = event.attempts + 1 < MAX_EVENT_ATTEMPTS;
      await prisma.journeyEvent.update({
        where: { id: event.id },
        data: {
          status: retry ? "pending" : "failed",
          availableAt: retry ? new Date(Date.now() + 5 * 60_000) : event.availableAt,
          error: message.slice(0, 1000),
        },
      });
    }
  }

  return { processed: events.length, enrolled };
}
