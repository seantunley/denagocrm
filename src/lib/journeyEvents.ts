import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { loadJourneyContext, type JourneyEntityType } from "./journeyContext";
import {
  enqueueJourneyRun,
  getActiveVersion,
  hashJourneyKey,
  jsonObject,
} from "./journeyEngineShared";

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
  context: Awaited<ReturnType<typeof loadJourneyContext>>
) {
  if (!context) return false;
  if (trigger === "stage_entered") {
    const lead = (context.lead ?? {}) as Record<string, unknown>;
    return !config.stageId || config.stageId === lead.stageId;
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

export async function processJourneyEvents(limit = 50) {
  const events = await prisma.journeyEvent.findMany({
    where: { status: "pending", availableAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let enrolled = 0;

  for (const event of events) {
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

      for (const journey of journeys) {
        const version = getActiveVersion(journey);
        if (!version || version.trigger !== event.type) continue;
        if (!triggerMatches(version.trigger, jsonObject(version.triggerConfig), context)) continue;
        if (await enqueueJourneyRun({
          journey,
          version,
          entityType: event.entityType as JourneyEntityType,
          entityId: event.entityId,
          eventKey: event.dedupeKey,
          payload: eventPayload,
        })) enrolled++;
      }

      await prisma.journeyEvent.update({
        where: { id: event.id },
        data: { status: "processed", processedAt: new Date() },
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
