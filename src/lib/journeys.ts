import crypto from "crypto";
import { differenceInCalendarMonths, subDays } from "date-fns";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { resolveContacts, type SegmentCriteria } from "./campaigns";
import { executeJourneyStep } from "./journeyStepExecutor";
import { loadJourneyContext, type JourneyEntityType, type JourneyContext } from "./journeyContext";
import {
  evaluateConditions,
  parseConditionGroup,
  parseJourneyDefinition,
  stepById,
  type JourneyDefinition,
} from "./journeyTypes";

const MAX_EVENT_ATTEMPTS = 3;
const MAX_RUN_ATTEMPTS = 3;
const MAX_STEPS_PER_TICK = 20;

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const jsonObject = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

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
        dedupeKey: hash(args.dedupeKey),
        journeyId: args.journeyId,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null;
    throw error;
  }
}

async function activeVersion(journey: {
  activeVersion: number | null;
  versions: Array<{
    id: string;
    version: number;
    trigger: string;
    triggerConfig: Prisma.JsonValue | null;
    entryConditions: Prisma.JsonValue | null;
    definition: Prisma.JsonValue;
  }>;
}) {
  return journey.versions.find((version) => version.version === journey.activeVersion) ?? null;
}

function triggerMatches(
  trigger: string,
  config: Record<string, unknown>,
  context: JourneyContext
) {
  if (trigger === "stage_entered") {
    const lead = (context.lead ?? {}) as Record<string, unknown>;
    return !config.stageId || config.stageId === lead.stageId;
  }
  return true;
}

async function enqueueRun(args: {
  journey: { id: string; name: string; category: string };
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
  const idempotencyKey = hash(
    `${args.journey.id}:${args.version.version}:${args.eventKey}:${args.entityType}:${args.entityId}`
  );

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
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
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
      const context = await loadJourneyContext(event.entityType as JourneyEntityType, event.entityId, {
        ...payload,
        type: event.type,
      });
      if (!context) throw new Error("Journey event entity no longer exists");

      for (const journey of journeys) {
        const version = await activeVersion(journey);
        if (!version || version.trigger !== event.type) continue;
        if (!triggerMatches(version.trigger, jsonObject(version.triggerConfig), context)) continue;
        if (await enqueueRun({
          journey,
          version,
          entityType: event.entityType as JourneyEntityType,
          entityId: event.entityId,
          eventKey: event.dedupeKey,
          payload: { ...payload, type: event.type },
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

async function updateStepLog(args: {
  runId: string;
  stepId: string;
  stepType: string;
  status: string;
  note?: string;
  output?: Record<string, unknown>;
}) {
  await prisma.journeyStepLog.upsert({
    where: { runId_stepId: { runId: args.runId, stepId: args.stepId } },
    create: {
      runId: args.runId,
      stepId: args.stepId,
      stepType: args.stepType,
      status: args.status,
      note: args.note,
      output: args.output as Prisma.InputJsonValue | undefined,
      completedAt: ["completed", "skipped", "failed"].includes(args.status) ? new Date() : null,
    },
    update: {
      status: args.status,
      note: args.note,
      output: args.output as Prisma.InputJsonValue | undefined,
      completedAt: ["completed", "skipped", "failed"].includes(args.status) ? new Date() : null,
    },
  });
}

async function processOneRun(runId: string) {
  const run = await prisma.journeyRun.findUnique({
    where: { id: runId },
    include: { journey: true, journeyVersion: true },
  });
  if (!run || !["queued", "waiting", "running"].includes(run.status)) return false;

  const claimed = await prisma.journeyRun.updateMany({
    where: { id: run.id, status: { in: ["queued", "waiting"] }, nextRunAt: { lte: new Date() } },
    data: { status: "running", attempts: { increment: 1 }, startedAt: run.startedAt ?? new Date(), lastError: null },
  });
  if (run.status !== "running" && claimed.count === 0) return false;

  const definition = parseJourneyDefinition(run.journeyVersion.definition);
  let currentStepId = run.currentStepId;
  let context = run.context as unknown as JourneyContext;

  try {
    for (let count = 0; count < MAX_STEPS_PER_TICK; count++) {
      const step = stepById(definition, currentStepId);
      if (!step) {
        await prisma.journeyRun.update({
          where: { id: run.id },
          data: { status: "completed", currentStepId: null, completedAt: new Date(), context: context as Prisma.InputJsonValue },
        });
        await logAudit({
          action: "journey.completed",
          summary: `Journey “${run.journey.name}” completed`,
          leadId: run.leadId,
          contactId: run.contactId,
          userName: "Journey engine",
        });
        return true;
      }

      await updateStepLog({ runId: run.id, stepId: step.id, stepType: step.type, status: "running" });
      const result = await executeJourneyStep({
        step,
        context,
        category: run.journey.category,
        journeyName: run.journey.name,
        runId: run.id,
      });
      const nextStepId = result.nextStepId === undefined ? step.nextStepId ?? null : result.nextStepId;
      await updateStepLog({
        runId: run.id,
        stepId: step.id,
        stepType: step.type,
        status: result.status === "skipped" ? "skipped" : "completed",
        note: result.note,
        output: { ...result.output, nextStepId, nextRunAt: result.nextRunAt?.toISOString() },
      });

      if (result.status === "waiting") {
        await prisma.journeyRun.update({
          where: { id: run.id },
          data: {
            status: "waiting",
            currentStepId: nextStepId,
            nextRunAt: result.nextRunAt ?? new Date(Date.now() + 60_000),
            context: context as Prisma.InputJsonValue,
          },
        });
        return true;
      }

      currentStepId = nextStepId;
      const refreshed = await loadJourneyContext(
        run.entityType as JourneyEntityType,
        run.entityId,
        (context.event ?? {}) as Record<string, unknown>
      );
      if (refreshed) context = refreshed;
      await prisma.journeyRun.update({
        where: { id: run.id },
        data: { currentStepId, context: context as Prisma.InputJsonValue },
      });
    }

    await prisma.journeyRun.update({
      where: { id: run.id },
      data: { status: "queued", nextRunAt: new Date(Date.now() + 60_000), currentStepId },
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown journey run error";
    if (currentStepId) {
      const step = stepById(definition, currentStepId);
      if (step) await updateStepLog({
        runId: run.id,
        stepId: step.id,
        stepType: step.type,
        status: "failed",
        note: message.slice(0, 1000),
      });
    }
    const retry = run.attempts + 1 < MAX_RUN_ATTEMPTS;
    await prisma.journeyRun.update({
      where: { id: run.id },
      data: {
        status: retry ? "queued" : "failed",
        nextRunAt: retry ? new Date(Date.now() + 5 * 60_000) : run.nextRunAt,
        lastError: message.slice(0, 1000),
      },
    });
    return false;
  }
}

export async function processJourneyRuns(limit = 40) {
  const runs = await prisma.journeyRun.findMany({
    where: { status: { in: ["queued", "waiting"] }, nextRunAt: { lte: new Date() } },
    orderBy: { nextRunAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let processed = 0;
  for (const run of runs) if (await processOneRun(run.id)) processed++;
  return processed;
}

function recurrenceWindow(repeat: unknown, now = new Date()) {
  if (repeat === "daily") return now.toISOString().slice(0, 10);
  if (repeat === "weekly") {
    const start = new Date(now);
    start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return start.toISOString().slice(0, 10);
  }
  return "once";
}

async function scheduleJourney(journey: {
  id: string;
  activeVersion: number | null;
  versions: Array<{
    id: string;
    version: number;
    trigger: string;
    triggerConfig: Prisma.JsonValue | null;
  }>;
}) {
  const version = await activeVersion(journey);
  if (!version) return 0;
  const config = jsonObject(version.triggerConfig);
  let created = 0;

  if (version.trigger === "lead_idle") {
    const days = Math.max(1, Number(config.idleDays ?? 3));
    const leads = await prisma.lead.findMany({
      where: { status: "open", updatedAt: { lt: subDays(new Date(), days) } },
      select: { id: true },
      take: 1000,
    });
    for (const lead of leads) {
      if (await emitJourneyEvent({
        type: version.trigger,
        entityType: "lead",
        entityId: lead.id,
        journeyId: journey.id,
        payload: { idleDays: days },
        dedupeKey: `${journey.id}:${version.version}:lead-idle:${lead.id}`,
      })) created++;
    }
  }

  if (version.trigger === "contact_segment") {
    const segmentId = typeof config.segmentId === "string" ? config.segmentId : null;
    if (!segmentId) return created;
    const segment = await prisma.segment.findUnique({ where: { id: segmentId } });
    if (!segment) return created;
    const criteria = JSON.parse(segment.criteria) as SegmentCriteria;
    const contacts = await resolveContacts(criteria, "any");
    const window = recurrenceWindow(config.repeat);
    for (const contact of contacts) {
      if (await emitJourneyEvent({
        type: version.trigger,
        entityType: "contact",
        entityId: contact.id,
        journeyId: journey.id,
        payload: { segmentId, window },
        dedupeKey: `${journey.id}:${version.version}:segment:${contact.id}:${window}`,
      })) created++;
    }
  }

  if (version.trigger === "purchase_anniversary") {
    const now = new Date();
    const vehicles = await prisma.vehicle.findMany({
      where: { purchaseDate: { not: null }, deletedAt: null },
      select: { id: true, contactId: true, model: true, purchaseDate: true },
    });
    for (const vehicle of vehicles) {
      const purchased = vehicle.purchaseDate!;
      if (purchased.getMonth() !== now.getMonth() || purchased.getDate() !== now.getDate()) continue;
      const years = now.getFullYear() - purchased.getFullYear();
      if (years < 1) continue;
      if (await emitJourneyEvent({
        type: version.trigger,
        entityType: "contact",
        entityId: vehicle.contactId,
        journeyId: journey.id,
        payload: { vehicleId: vehicle.id, model: vehicle.model, years },
        dedupeKey: `${journey.id}:${version.version}:anniversary:${vehicle.id}:${now.getFullYear()}`,
      })) created++;
    }
  }

  if (version.trigger === "win_back") {
    const months = Math.max(3, Number(config.inactiveMonths ?? 12));
    const vehicles = await prisma.vehicle.findMany({
      where: { deletedAt: null },
      include: {
        contact: { include: { communications: { orderBy: { occurredAt: "desc" }, take: 1 } } },
        serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
      },
    });
    const now = new Date();
    const window = `${now.getFullYear()}-${Math.floor(now.getMonth() / 6) + 1}`;
    const seen = new Set<string>();
    for (const vehicle of vehicles) {
      const contact = vehicle.contact;
      if (seen.has(contact.id) || contact.marketingOptOut) continue;
      const baseline = vehicle.serviceRecords[0]?.serviceDate ?? vehicle.purchaseDate;
      if (!baseline || differenceInCalendarMonths(now, baseline) < months) continue;
      const lastContact = contact.communications[0]?.occurredAt;
      if (lastContact && differenceInCalendarMonths(now, lastContact) < 3) continue;
      seen.add(contact.id);
      if (await emitJourneyEvent({
        type: version.trigger,
        entityType: "contact",
        entityId: contact.id,
        journeyId: journey.id,
        payload: { vehicleId: vehicle.id, model: vehicle.model, inactiveMonths: months },
        dedupeKey: `${journey.id}:${version.version}:winback:${contact.id}:${window}`,
      })) created++;
    }
  }

  return created;
}

export async function runScheduledJourneyEnrollments() {
  const journeys = await prisma.journey.findMany({
    where: { status: "active" },
    include: { versions: { where: { state: "published" } } },
  });
  let created = 0;
  for (const journey of journeys) created += await scheduleJourney(journey);
  return created;
}

export async function runJourneyEngine() {
  const scheduled = await runScheduledJourneyEnrollments();
  const events = await processJourneyEvents();
  const runs = await processJourneyRuns();
  return { scheduled, eventsProcessed: events.processed, enrolled: events.enrolled, runsProcessed: runs };
}
