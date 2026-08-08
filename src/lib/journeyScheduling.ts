import { differenceInCalendarMonths, subDays } from "date-fns";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { resolveContacts, type SegmentCriteria } from "./campaigns";
import { emitJourneyEvent } from "./journeyEvents";
import { leadHasGoneQuiet } from "./leadIdle";
import { getActiveVersion } from "./journeyEngineShared";
import { journeyTenantId } from "./journeyTenant";
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

/**
 * Every sweep below names `tenantId` in its own `where`, and it is ALWAYS the
 * one this slice resolved at its entry point — never a value read back off a
 * row the sweep just fetched. See lib/journeyTenant.ts for why the db.ts guard
 * is not enough on its own: with enforcement off it scopes nothing, so an
 * unqualified sweep here reads every workspace's leads, contacts and vehicles
 * and then EMITS EVENTS for them, which the run phase turns into real sends.
 */
async function sweepTrigger(
  tenantId: string,
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
      where: { tenantId, status: "open", updatedAt: { lt: subDays(now, days) } },
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
    // THE SEGMENT IS FETCHED BY (id, tenantId), AND THE AUDIENCE IS RESOLVED FOR
    // THIS SLICE'S TENANT — never for the tenant written on the segment row.
    //
    // `segmentId` is a value on a journey version. It reached the row through
    // the builder, but nothing downstream re-checks it, and versions are
    // imported, cloned from templates and (before the automations engine was
    // retired) machine-translated — so it must be treated as an id from
    // anywhere. Looked up by id alone and then trusted, the pair
    // `findUnique({ id }) → resolveContacts(segment.tenantId, …)` reads the
    // acting tenant OFF THE ROW IT JUST FOUND: point one workspace's journey at
    // another workspace's segment and the sweep obediently fetches that other
    // workspace's contacts and enrols them, with enforcement off closing
    // nothing. Naming the tenant in the `where` means a foreign id simply does
    // not resolve, so there is no row to read a tenant from and no check to
    // forget. findFirst, not findUnique: the pair is not a unique index, and the
    // point is to filter in the database rather than compare afterwards.
    const segment = await prisma.segment.findFirst({ where: { id: segmentId, tenantId } });
    if (!segment) return created;
    let criteria: SegmentCriteria;
    try {
      criteria = JSON.parse(segment.criteria) as SegmentCriteria;
    } catch {
      throw new Error(`Segment ${segment.name} has invalid criteria JSON`);
    }
    const contacts = await resolveContacts(tenantId, criteria, "any");
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
      where: { tenantId, purchaseDate: { not: null }, deletedAt: null },
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
    // The nested reads carry the tenant too. The extension only ever intercepts
    // the TOP-LEVEL operation, so an `include` is unscoped in BOTH modes — and
    // a single-column FK does not make a child row share its parent's tenant
    // until the composite FKs land. A borrowed communication would silently
    // suppress a win-back; a borrowed service record would silently trigger one.
    const vehicles = await prisma.vehicle.findMany({
      where: { tenantId, deletedAt: null },
      include: {
        contact: {
          include: {
            communications: { where: { tenantId }, orderBy: { occurredAt: "desc" }, take: 1 },
          },
        },
        serviceRecords: { where: { tenantId }, orderBy: { serviceDate: "desc" }, take: 1 },
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
async function scheduleJourney(tenantId: string, journey: SchedulableJourney, stop: StopSignal) {
  const version = getActiveVersion(journey);
  if (!version) return 0;
  let created = 0;
  for (const spec of readJourneyTriggers(version.triggers)) {
    if (stop.shouldStop(ENROL_RESERVE_MS)) break;
    created += await sweepTrigger(tenantId, journey, version, spec, stop);
  }
  return created;
}

export async function runScheduledJourneyEnrollments(stop: StopSignal = NEVER_STOP) {
  // ONE resolution for the whole sweep, taken before the first query and passed
  // down, so every read and every emitted event names the same tenant by
  // construction. Resolving per query would be the same value today and a
  // divergence waiting to happen; resolving from a fetched row would be the
  // hole this exists to close.
  const tenantId = journeyTenantId();
  const journeys = await prisma.journey.findMany({
    where: { tenantId, status: "active" },
    // The nested version read names the tenant as well: `include` is not a
    // top-level operation, so the guard never touches it even under
    // enforcement, and a published version belonging to someone else would
    // otherwise decide who this journey enrols and what it sends them.
    include: { versions: { where: { tenantId, state: "published" } } },
  });
  let created = 0;
  for (const journey of journeys) {
    if (stop.shouldStop(ENROL_RESERVE_MS)) break;
    created += await scheduleJourney(tenantId, journey, stop);
  }
  return created;
}

export async function enrollJourneyNow(journeyId: string) {
  const tenantId = journeyTenantId();
  // Scoped by (id, tenantId) rather than fetched and then checked: another
  // workspace's journeyId simply does not resolve, and the "must be active"
  // error below cannot become an oracle for whether that journey exists.
  const journey = await prisma.journey.findFirst({
    where: { id: journeyId, tenantId },
    include: { versions: { where: { tenantId, state: "published" } } },
  });
  if (!journey || journey.status !== "active") throw new Error("Journey must be active before it can run");
  return scheduleJourney(tenantId, journey, NEVER_STOP);
}
import { NEVER_STOP, type StopSignal } from "./stopSignal";

/**
 * Time to keep in hand before enrolling one more record. Each enrolment writes
 * and can start a journey run, which sends.
 */
const ENROL_RESERVE_MS = 3_000;
