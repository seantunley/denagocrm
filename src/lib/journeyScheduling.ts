import { differenceInCalendarMonths, subDays, subHours } from "date-fns";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { resolveContacts, type SegmentCriteria } from "./campaigns";
import { computeDue } from "./serviceDue";
import { computeWarranty } from "./warranty";
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

function day(value: Date) {
  return value.toISOString().slice(0, 10);
}

function numberConfig(config: Record<string, unknown>, key: string, fallback: number, min = 0, max = 3650) {
  const parsed = Number(config[key]);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

type SchedulableJourney = {
  id: string;
  tenantId: string | null;
  activeVersion: number | null;
  versions: Array<{
    id: string;
    version: number;
    trigger: string;
    triggerConfig: Prisma.JsonValue | null;
  }>;
};

async function emit(args: {
  journey: SchedulableJourney;
  version: number;
  trigger: string;
  entityType: "lead" | "contact" | "system";
  entityId: string;
  cycle: string;
  payload: Record<string, unknown>;
}) {
  return Boolean(await emitJourneyEvent({
    type: args.trigger,
    entityType: args.entityType,
    entityId: args.entityId,
    journeyId: args.journey.id,
    tenantId: args.journey.tenantId,
    payload: args.payload,
    dedupeKey: `${args.journey.id}:${args.version}:${args.trigger}:${args.entityType}:${args.entityId}:${args.cycle}`,
  }));
}

async function scheduleJourney(journey: SchedulableJourney) {
  const version = getActiveVersion(journey);
  if (!version) return 0;
  const config = jsonObject(version.triggerConfig);
  const now = new Date();
  let created = 0;

  if (version.trigger === "lead_idle") {
    const days = numberConfig(config, "idleDays", 3, 1, 365);
    const leads = await prisma.lead.findMany({
      where: { status: "open", updatedAt: { lt: subDays(now, days) } },
      select: { id: true, updatedAt: true },
      take: 1000,
    });
    for (const lead of leads) {
      if (await emit({ journey, version: version.version, trigger: version.trigger, entityType: "lead", entityId: lead.id, cycle: lead.updatedAt.toISOString(), payload: { idleDays: days, source: { id: lead.id, updatedAt: lead.updatedAt } } })) created++;
    }
  }

  if (version.trigger === "activity_overdue") {
    const overdueMinutes = numberConfig(config, "overdueMinutes", 0, 0, 525600);
    const cutoff = new Date(now.getTime() - overdueMinutes * 60_000);
    const rows = await prisma.activity.findMany({
      where: { status: "planned", dueDate: { lt: cutoff } },
      select: { id: true, type: true, summary: true, dueDate: true, leadId: true, contactId: true, assignedToId: true, location: true },
      take: 1000,
    });
    for (const row of rows) {
      const entityType = row.leadId ? "lead" : row.contactId ? "contact" : "system";
      const entityId = row.leadId ?? row.contactId ?? row.id;
      const hoursOverdue = Math.max(0, Math.round((now.getTime() - row.dueDate.getTime()) / 3_600_000));
      if (await emit({ journey, version: version.version, trigger: version.trigger, entityType, entityId, cycle: row.dueDate.toISOString(), payload: { hoursOverdue, source: row } })) created++;
    }
  }

  if (version.trigger === "quote_expiring") {
    const daysBefore = numberConfig(config, "daysBefore", 3, 0, 365);
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysBefore);
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
    const quotes = await prisma.quote.findMany({
      where: { status: "sent", validUntil: { gte: from, lt: to }, deletedAt: null },
      select: { id: true, number: true, validUntil: true, leadId: true, contactId: true },
      take: 1000,
    });
    for (const quote of quotes) {
      const entityType = quote.leadId ? "lead" : quote.contactId ? "contact" : "system";
      const entityId = quote.leadId ?? quote.contactId ?? quote.id;
      if (await emit({ journey, version: version.version, trigger: version.trigger, entityType, entityId, cycle: day(quote.validUntil!), payload: { daysUntilExpiry: daysBefore, source: { ...quote, reference: `Q-${quote.number}` } } })) created++;
    }
  }

  if (version.trigger === "delivery_delayed") {
    const graceHours = numberConfig(config, "graceHours", 1, 0, 720);
    const cutoff = subHours(now, graceHours);
    const quotes = await prisma.quote.findMany({
      where: { deliveryScheduledFor: { lt: cutoff }, deliveredAt: null, status: "accepted", deletedAt: null },
      select: { id: true, number: true, deliveryScheduledFor: true, leadId: true, contactId: true },
      take: 1000,
    });
    for (const quote of quotes) {
      const entityType = quote.leadId ? "lead" : quote.contactId ? "contact" : "system";
      const entityId = quote.leadId ?? quote.contactId ?? quote.id;
      if (await emit({ journey, version: version.version, trigger: version.trigger, entityType, entityId, cycle: quote.deliveryScheduledFor!.toISOString(), payload: { graceHours, source: { ...quote, reference: `Q-${quote.number}` } } })) created++;
    }
  }

  if (version.trigger === "case_overdue") {
    const hours = numberConfig(config, "hours", 24, 1, 2160);
    const priority = typeof config.priority === "string" && config.priority ? config.priority : null;
    const cases = await prisma.customerCase.findMany({
      where: {
        status: { notIn: ["resolved", "closed"] },
        updatedAt: { lt: subHours(now, hours) },
        ...(priority ? { priority } : {}),
      },
      select: { id: true, number: true, subject: true, contactId: true, status: true, priority: true, updatedAt: true, assignedToId: true },
      take: 1000,
    });
    for (const item of cases) {
      if (await emit({ journey, version: version.version, trigger: version.trigger, entityType: "contact", entityId: item.contactId, cycle: item.updatedAt.toISOString(), payload: { hoursOverdue: hours, priority: item.priority, status: item.status, source: { ...item, reference: `C-${item.number}` } } })) created++;
    }
  }

  if (version.trigger === "service_due") {
    const wanted = typeof config.status === "string" ? config.status : "any";
    const vehicles = await prisma.vehicle.findMany({
      where: { deletedAt: null },
      include: {
        serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
        mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1 },
      },
      take: 2000,
    });
    for (const vehicle of vehicles) {
      const due = computeDue(vehicle, now);
      if (!["due_soon", "overdue"].includes(due.status)) continue;
      if (wanted !== "any" && wanted !== due.status) continue;
      const cycle = `${due.nextDueDate ? day(due.nextDueDate) : "nodate"}-${due.nextDueKm ?? "nokm"}`;
      if (await emit({ journey, version: version.version, trigger: version.trigger, entityType: "contact", entityId: vehicle.contactId, cycle, payload: { status: due.status, source: { id: vehicle.id, model: vehicle.model, ...due } } })) created++;
    }
  }

  if (version.trigger === "warranty_expiring") {
    const daysBefore = numberConfig(config, "daysBefore", 30, 0, 730);
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysBefore);
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
    const vehicles = await prisma.vehicle.findMany({
      where: { deletedAt: null, purchaseDate: { not: null }, warrantyMonths: { not: null } },
      select: { id: true, model: true, vin: true, contactId: true, purchaseDate: true, warrantyMonths: true },
      take: 2000,
    });
    for (const vehicle of vehicles) {
      const { expiryDate } = computeWarranty(vehicle, now);
      if (!expiryDate || expiryDate < from || expiryDate >= to) continue;
      if (await emit({ journey, version: version.version, trigger: version.trigger, entityType: "contact", entityId: vehicle.contactId, cycle: day(expiryDate), payload: { daysUntilExpiry: daysBefore, source: vehicle } })) created++;
    }
  }

  if (version.trigger === "signature_request_stalled") {
    const stalledHours = numberConfig(config, "stalledHours", 48, 1, 2160);
    const requests = await prisma.signatureRequest.findMany({
      where: { status: { in: ["sent", "viewed"] }, completedAt: null, sentAt: { lt: subHours(now, stalledHours) } },
      select: { id: true, title: true, status: true, sentAt: true, quoteId: true, jobCardId: true, contactId: true },
      take: 1000,
    });
    for (const request of requests) {
      let contactId = request.contactId;
      let leadId: string | null = null;
      if (request.quoteId) {
        const quote = await prisma.quote.findUnique({ where: { id: request.quoteId }, select: { contactId: true, leadId: true } });
        contactId = contactId ?? quote?.contactId ?? null;
        leadId = quote?.leadId ?? null;
      }
      if (!contactId && request.jobCardId) {
        const job = await prisma.jobCard.findUnique({ where: { id: request.jobCardId }, select: { contactId: true } });
        contactId = job?.contactId ?? null;
      }
      const entityType = leadId ? "lead" : contactId ? "contact" : "system";
      const entityId = leadId ?? contactId ?? request.id;
      if (await emit({ journey, version: version.version, trigger: version.trigger, entityType, entityId, cycle: request.sentAt!.toISOString(), payload: { hoursOverdue: stalledHours, status: request.status, source: request } })) created++;
    }
  }

  if (version.trigger === "contact_segment") {
    const segmentId = typeof config.segmentId === "string" ? config.segmentId : null;
    if (!segmentId) return created;
    const segment = await prisma.segment.findUnique({ where: { id: segmentId } });
    if (!segment) return created;
    let criteria: SegmentCriteria;
    try { criteria = JSON.parse(segment.criteria) as SegmentCriteria; }
    catch { throw new Error(`Segment ${segment.name} has invalid criteria JSON`); }
    const contacts = await resolveContacts(criteria, "any");
    const window = recurrenceWindow(config.repeat);
    for (const contact of contacts) {
      if (await emit({ journey, version: version.version, trigger: version.trigger, entityType: "contact", entityId: contact.id, cycle: window, payload: { segmentId, window } })) created++;
    }
  }

  if (version.trigger === "purchase_anniversary") {
    const vehicles = await prisma.vehicle.findMany({
      where: { purchaseDate: { not: null }, deletedAt: null },
      select: { id: true, contactId: true, model: true, purchaseDate: true },
    });
    for (const vehicle of vehicles) {
      const purchased = vehicle.purchaseDate!;
      if (purchased.getMonth() !== now.getMonth() || purchased.getDate() !== now.getDate()) continue;
      const years = now.getFullYear() - purchased.getFullYear();
      if (years < 1) continue;
      if (await emit({ journey, version: version.version, trigger: version.trigger, entityType: "contact", entityId: vehicle.contactId, cycle: String(now.getFullYear()), payload: { vehicleId: vehicle.id, model: vehicle.model, years } })) created++;
    }
  }

  if (version.trigger === "win_back") {
    const months = numberConfig(config, "inactiveMonths", 12, 3, 120);
    const vehicles = await prisma.vehicle.findMany({
      where: { deletedAt: null },
      include: {
        contact: { include: { communications: { orderBy: { occurredAt: "desc" }, take: 1 } } },
        serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
      },
    });
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
      if (await emit({ journey, version: version.version, trigger: version.trigger, entityType: "contact", entityId: contact.id, cycle: window, payload: { vehicleId: vehicle.id, model: vehicle.model, inactiveMonths: months } })) created++;
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
