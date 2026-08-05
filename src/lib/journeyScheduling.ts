import { differenceInCalendarMonths, subDays } from "date-fns";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { resolveContacts, type SegmentCriteria } from "./campaigns";
import { emitJourneyEvent } from "./journeyEvents";
import { leadHasGoneQuiet } from "./leadIdle";
import { getActiveVersion } from "./journeyEngineShared";
import { readJourneyTriggers, triggerKeySuffix, type JourneyTriggerSpec } from "./journeyTriggers";

function recurrenceWindow(repeat: unknown, now = new Date()) {
  if (repeat === "daily") return now.toISOString().slice(0, 10);
  if (repeat === "weekly") {
    const start = new Date(now);
    start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return start.toISOString().slice(0, 10);
  }
  return "once";
}

type SchedulableJourney = {
  id: string;
  activeVersion: number | null;
  versions: Array<{
    id: string;
    version: number;
    triggers: Prisma.JsonValue;
  }>;
};

/**
 * What the payload carries so the matcher can tell two same-type triggers apart.
 *
 * Without it, both `lead_idle` triggers on a version would sweep separately with
 * their own idleDays and then both be attributed to whichever appears first in
 * the list — one configuration would emit events that never name it.
 */
const named = (spec: JourneyTriggerSpec) => (spec.id ? { triggerId: spec.id } : {});

async function sweepTrigger(
  journey: SchedulableJourney,
  version: { version: number },
  spec: JourneyTriggerSpec,
  stop: StopSignal,
) {
  const config = spec.config;
  let created = 0;

  if (spec.type === "lead_idle") {
    const days = Math.max(1, Number(config.idleDays ?? 3));
    const now = new Date();
    // Narrow to leads whose own row is already stale; a lead touched more
    // recently than the cutoff is engaged by definition and can't be idle.
    const leads = await prisma.lead.findMany({
      where: { status: "open", updatedAt: { lt: subDays(now, days) } },
      select: { id: true, contactId: true, updatedAt: true },
      take: 1000,
    });
    for (const lead of leads) {
      if (stop.shouldStop(ENROL_RESERVE_MS)) break;
      // The row timestamp alone is NOT the test — see lib/leadIdle.ts. This
      // check came from the retired AutomationRule engine; without it, retiring
      // that engine would have started nudging customers who are mid-decision on
      // a quote we sent, or who have a follow-up call already booked.
      if (!(await leadHasGoneQuiet(lead, days, now))) continue;
      if (await emitJourneyEvent({
        type: spec.type,
        entityType: "lead",
        entityId: lead.id,
        journeyId: journey.id,
        payload: { idleDays: days, ...named(spec) },
        dedupeKey: `${journey.id}:${version.version}:lead-idle:${lead.id}${triggerKeySuffix(spec)}`,
      })) created++;
    }
  }

  if (spec.type === "contact_segment") {
    const segmentId = typeof config.segmentId === "string" ? config.segmentId : null;
    if (!segmentId) return created;
    const segment = await prisma.segment.findUnique({ where: { id: segmentId } });
    if (!segment?.tenantId) return created;
    let criteria: SegmentCriteria;
    try {
      criteria = JSON.parse(segment.criteria) as SegmentCriteria;
    } catch {
      throw new Error(`Segment ${segment.name} has invalid criteria JSON`);
    }
    const contacts = await resolveContacts(segment.tenantId, criteria, "any");
    const window = recurrenceWindow(config.repeat);
    for (const contact of contacts) {
      if (stop.shouldStop(ENROL_RESERVE_MS)) break;
      if (await emitJourneyEvent({
        type: spec.type,
        entityType: "contact",
        entityId: contact.id,
        journeyId: journey.id,
        payload: { segmentId, window, ...named(spec) },
        dedupeKey: `${journey.id}:${version.version}:segment:${contact.id}:${window}${triggerKeySuffix(spec)}`,
      })) created++;
    }
  }

  if (spec.type === "purchase_anniversary") {
    const now = new Date();
    const vehicles = await prisma.vehicle.findMany({
      where: { purchaseDate: { not: null }, deletedAt: null },
      select: { id: true, contactId: true, model: true, purchaseDate: true },
    });
    for (const vehicle of vehicles) {
      if (stop.shouldStop(ENROL_RESERVE_MS)) break;
      const purchased = vehicle.purchaseDate!;
      if (purchased.getMonth() !== now.getMonth() || purchased.getDate() !== now.getDate()) continue;
      const years = now.getFullYear() - purchased.getFullYear();
      if (years < 1) continue;
      if (await emitJourneyEvent({
        type: spec.type,
        entityType: "contact",
        entityId: vehicle.contactId,
        journeyId: journey.id,
        payload: { vehicleId: vehicle.id, model: vehicle.model, years, ...named(spec) },
        dedupeKey: `${journey.id}:${version.version}:anniversary:${vehicle.id}:${now.getFullYear()}${triggerKeySuffix(spec)}`,
      })) created++;
    }
  }

  if (spec.type === "win_back") {
    const months = Math.max(3, Number(config.inactiveMonths ?? 12));
    const vehicles = await prisma.vehicle.findMany({
      where: { deletedAt: null },
      include: {
        contact: {
          include: {
            communications: { orderBy: { occurredAt: "desc" }, take: 1 },
          },
        },
        serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
      },
    });
    const now = new Date();
    const window = `${now.getFullYear()}-${Math.floor(now.getMonth() / 6) + 1}`;
    const seen = new Set<string>();
    for (const vehicle of vehicles) {
      if (stop.shouldStop(ENROL_RESERVE_MS)) break;
      const contact = vehicle.contact;
      if (seen.has(contact.id) || contact.marketingOptOut) continue;
      const baseline = vehicle.serviceRecords[0]?.serviceDate ?? vehicle.purchaseDate;
      if (!baseline || differenceInCalendarMonths(now, baseline) < months) continue;
      const lastContact = contact.communications[0]?.occurredAt;
      if (lastContact && differenceInCalendarMonths(now, lastContact) < 3) continue;
      seen.add(contact.id);
      if (await emitJourneyEvent({
        type: spec.type,
        entityType: "contact",
        entityId: contact.id,
        journeyId: journey.id,
        payload: { vehicleId: vehicle.id, model: vehicle.model, inactiveMonths: months, ...named(spec) },
        dedupeKey: `${journey.id}:${version.version}:winback:${contact.id}:${window}${triggerKeySuffix(spec)}`,
      })) created++;
    }
  }

  return created;
}

/**
 * Sweep for EVERY scheduled trigger the active version lists, not just one.
 *
 * A trigger this function has no sweep for is an EVENT trigger — some write path
 * emits it — so it is passed over here rather than treated as a gap.
 */
async function scheduleJourney(journey: SchedulableJourney, stop: StopSignal) {
  const version = getActiveVersion(journey);
  if (!version) return 0;
  let created = 0;
  for (const spec of readJourneyTriggers(version.triggers)) {
    if (stop.shouldStop(ENROL_RESERVE_MS)) break;
    created += await sweepTrigger(journey, version, spec, stop);
  }
  return created;
}

export async function runScheduledJourneyEnrollments(stop: StopSignal = NEVER_STOP) {
  const journeys = await prisma.journey.findMany({
    where: { status: "active" },
    include: { versions: { where: { state: "published" } } },
  });
  let created = 0;
  for (const journey of journeys) {
    if (stop.shouldStop(ENROL_RESERVE_MS)) break;
    created += await scheduleJourney(journey, stop);
  }
  return created;
}

export async function enrollJourneyNow(journeyId: string) {
  const journey = await prisma.journey.findUnique({
    where: { id: journeyId },
    include: { versions: { where: { state: "published" } } },
  });
  if (!journey || journey.status !== "active") throw new Error("Journey must be active before it can run");
  return scheduleJourney(journey, NEVER_STOP);
}
import { NEVER_STOP, type StopSignal } from "./stopSignal";

/**
 * Time to keep in hand before enrolling one more record. Each enrolment writes
 * and can start a journey run, which sends.
 */
const ENROL_RESERVE_MS = 3_000;
