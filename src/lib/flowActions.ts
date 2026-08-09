/**
 * CRM-connected flow actions shared by every channel adapter. Side effects are
 * keyed by leased inbound provider event + executing node id so a retry after
 * partial success recognizes business effects already committed.
 */
import crypto from "crypto";
import { addDays, format } from "date-fns";
import { prisma } from "./db";
import { getDayAvailability, reserveSlot } from "./bookingSlots";
import { createIntakeLead } from "./leadIntake";
import { createLeadRecordIfPipelineReady } from "./leadCreate";
import { sendPushToAll } from "./push";
import { resolveTenantActor } from "./tenantActor";
import { currentInboundBotEventId } from "./botInboundEvent";
import { cancelBotBooking, lookupBotBooking, rescheduleBotBooking } from "./botBookingSelfService";
import { enrollEntityInJourney } from "./journeyDirectEnrollment";

type Match = { contactId: string | null; leadId: string | null };

export async function availableSlots(max = 6): Promise<{ id: string; label: string }[]> {
  const out: { id: string; label: string }[] = [];
  const start = new Date();
  for (let i = 0; i < 21 && out.length < max; i++) {
    const date = format(addDays(start, i), "yyyy-MM-dd");
    const day = await getDayAvailability(date);
    if (!day.open) continue;
    for (const s of day.slots) {
      if (!s.available) continue;
      out.push({ id: `${date}_${s.time}`, label: format(new Date(`${date}T${s.time}:00`), "EEE d MMM · HH:mm") });
      if (out.length >= max) break;
    }
  }
  return out;
}

export function botActionKey(nodeId: string, kind: string): string | null {
  const eventId = currentInboundBotEventId();
  return eventId ? `bot:${eventId}:${nodeId}:${kind}` : null;
}

export function botActionMarker(key: string | null, suffix = "effect"): string | null {
  if (!key) return null;
  const digest = crypto.createHash("sha256").update(`${key}:${suffix}`).digest("hex").slice(0, 32);
  return `[bot-action:${digest}]`;
}

function appendMarker(lines: Array<string | null | undefined>, marker: string | null): string | null {
  return [...lines, marker].filter(Boolean).join("\n") || null;
}

async function ensureContact(source: string, vars: Record<string, string>, match: Match): Promise<Match> {
  if (match.contactId) return match;

  // A provider retry or second action in one flow should reuse the captured
  // person instead of creating a new Contact before the idempotent effect check.
  const identity = [
    vars.phone ? { phone: vars.phone } : null,
    vars.email ? { email: vars.email } : null,
  ].filter(Boolean) as Array<{ phone: string } | { email: string }>;
  // A phone or email is required, not merely preferred: they are the only fields
  // the reuse lookup can match on. Creating a Contact from a bare name leaves the
  // next attempt nothing to find, so a redelivery — or the customer restarting the
  // flow — would add another one every time.
  if (!identity.length) return match;
  {
    const existing = await prisma.contact.findFirst({ where: { OR: identity } });
    if (existing) return { contactId: existing.id, leadId: match.leadId };
  }
  const [first, ...rest] = (vars.name || "Customer").trim().split(/\s+/);
  const c = await prisma.contact.create({ data: { firstName: first || "Customer", lastName: rest.join(" ") || null, phone: vars.phone || null, email: vars.email || null, source } });
  return { contactId: c.id, leadId: match.leadId };
}

/** Journey enrolment never creates identity merely to make an automation run. */
async function existingJourneyEntity(vars: Record<string, string>, match: Match): Promise<{ entityType: "lead" | "contact"; entityId: string } | null> {
  if (match.leadId) return { entityType: "lead", entityId: match.leadId };
  if (match.contactId) return { entityType: "contact", entityId: match.contactId };
  const identity = [vars.phone ? { phone: vars.phone } : null, vars.email ? { email: vars.email } : null]
    .filter(Boolean) as Array<{ phone: string } | { email: string }>;
  if (!identity.length) return null;
  const contact = await prisma.contact.findFirst({ where: { OR: identity }, select: { id: true } });
  return contact ? { entityType: "contact", entityId: contact.id } : null;
}

async function firstUserId(): Promise<string | null> { return (await resolveTenantActor())?.id ?? null; }
function fileLines(vars: Record<string, string>): string[] { return Object.values(vars).filter((v) => /^https?:\/\//.test(v)).map((v) => `Attachment: ${v}`); }
async function activityAlreadyExists(marker: string | null) { return marker ? prisma.activity.findFirst({ where: { note: { contains: marker } } }) : null; }

async function createDemo(source: string, vars: Record<string, string>, match: Match, nodeId: string) {
  const userId = await firstUserId();
  if (!userId) return;
  const key = botActionKey(nodeId, "demo");
  const marker = botActionMarker(key);
  const who = await ensureContact(source, vars, match);
  const title = `Demo / test drive — ${vars.name || "customer"}`;
  const lead = await createLeadRecordIfPipelineReady({
    title, name: vars.name || "Customer", phone: vars.phone || null, email: vars.email || null,
    source, contactId: who.contactId, externalId: key,
    audit: { action: "lead.received", summary: `Lead “${title}” created from a ${source} demo / test-drive request`, userName: "System" },
    push: { title: "Demo / test-drive request 🚗", body: vars.name || "Customer", kind: "bot_handoff" },
  });
  if (!lead || await activityAlreadyExists(marker)) return;
  await prisma.activity.create({
    data: {
      type: "test_drive", summary: `Test drive — ${vars.model || "cart"}`,
      note: appendMarker([vars.model ? `Model: ${vars.model}` : null, vars.date ? `Preferred: ${vars.date}` : null, ...fileLines(vars)], marker),
      location: vars.location || null, dueDate: new Date(), status: "planned", leadId: lead.id, contactId: who.contactId,
      assignedToId: userId, createdById: userId,
    },
  });
}

export function crmActions(source: string, match: Match) {
  return {
    availableSlots: () => availableSlots(),
    bookSlot: async (slotId: string, vars: Record<string, string>, nodeId: string): Promise<{ ok: boolean; label?: string }> => {
      const [date, time] = slotId.split("_");
      const userId = await firstUserId();
      if (!userId || !date || !time) return { ok: false };
      const key = botActionKey(nodeId, "slot");
      const marker = botActionMarker(key);
      const label = format(new Date(`${date}T${time}:00`), "EEE d MMM · HH:mm");
      if (await activityAlreadyExists(marker)) return { ok: true, label };
      const who = await ensureContact(source, vars, match);
      try {
        await reserveSlot({ date, time, summary: `Service booking (${source}) — ${vars.name || "customer"}${vars.service ? `: ${vars.service}` : ""}`, note: vars.service ? `Needs: ${vars.service}` : null, contactId: who.contactId, leadId: who.leadId, userId, dedupeMarker: marker });
        await sendPushToAll({ title: "New service booking 🔧", body: `${vars.name || "Customer"} — ${label}`, url: who.contactId ? `/contacts/${who.contactId}` : "/workshop-calendar" }, "bot_handoff").catch(() => {});
        return { ok: true, label };
      } catch { return { ok: false }; }
    },
    rescheduleSlot: async (slotId: string, vars: Record<string, string>, _nodeId: string) => vars.booking_id ? rescheduleBotBooking(vars.booking_id, slotId, match, vars) : { ok: false },
    manageBooking: async (action: "lookup" | "cancel", vars: Record<string, string>, _nodeId: string) => {
      if (action === "lookup") return lookupBotBooking(match, vars);
      if (!vars.booking_id) { vars.booking_cancelled = "no"; return { ok: false }; }
      return cancelBotBooking(vars.booking_id, match, vars);
    },
    startJourney: async (journeyId: string, vars: Record<string, string>, nodeId: string): Promise<{ ok: boolean; reason?: string }> => {
      const entity = await existingJourneyEntity(vars, match);
      const eventKey = botActionKey(nodeId, `journey:${journeyId}`);
      if (!entity || !eventKey) {
        vars.journey_started = "no";
        vars.journey_reason = !entity ? "Customer record not found" : "Journey action has no provider event identity";
        return { ok: false, reason: vars.journey_reason };
      }
      const result = await enrollEntityInJourney({
        journeyId,
        entityType: entity.entityType,
        entityId: entity.entityId,
        eventKey,
        payload: { channel: source },
      });
      vars.journey_started = result.ok ? "yes" : "no";
      vars.journey_reason = result.reason;
      if (result.runId) vars.journey_run_id = result.runId;
      return { ok: result.ok, reason: result.reason };
    },
    createBooking: async (vars: Record<string, string>, action: "service" | "demo" | "lead" | undefined, nodeId: string) => {
      if (action === "demo") return createDemo(source, vars, match, nodeId);
      if (action === "lead") {
        await createIntakeLead({ name: vars.name || `${source} enquiry`, email: vars.email || null, phone: vars.phone || null, message: vars.service || vars.message || "Chatbot enquiry", source, externalId: botActionKey(nodeId, "lead") });
        return;
      }
      const userId = await firstUserId();
      if (!userId) return;
      const key = botActionKey(nodeId, "service");
      const marker = botActionMarker(key);
      if (await activityAlreadyExists(marker)) return;
      const who = await ensureContact(source, vars, match);
      await prisma.activity.create({
        data: {
          type: "todo", category: "workshop", summary: `Service request (${source}) — ${vars.name || "customer"}`,
          note: appendMarker([vars.service ? `Needs: ${vars.service}` : null, vars.date ? `Preferred: ${vars.date}` : null, ...fileLines(vars)], marker),
          dueDate: new Date(), status: "planned", contactId: who.contactId, leadId: who.leadId, assignedToId: userId, createdById: userId,
        },
      });
      await sendPushToAll({ title: "New service request 🔧", body: vars.name || "Customer", url: who.contactId ? `/contacts/${who.contactId}` : "/inbox" }, "bot_handoff").catch(() => {});
    },
  };
}
