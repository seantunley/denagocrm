import { differenceInCalendarMonths, subDays } from "date-fns";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { resolveContacts, type SegmentCriteria } from "./campaigns";
import { emitJourneyEvent } from "./journeyEvents";
import { getActiveVersion, jsonObject } from "./journeyEngineShared";

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
    trigger: string;
    triggerConfig: Prisma.JsonValue | null;
  }>;
};

async function scheduleJourney(journey: SchedulableJourney) {
  const version = getActiveVersion(journey);
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

export async function enrollJourneyNow(journeyId: string) {
  const journey = await prisma.journey.findUnique({
    where: { id: journeyId },
    include: { versions: { where: { state: "published" } } },
  });
  if (!journey || journey.status !== "active") throw new Error("Journey must be active before it can run");
  return scheduleJourney(journey);
}
