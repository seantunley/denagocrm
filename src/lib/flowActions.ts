/**
 * CRM-connected flow actions shared by every channel adapter. Side effects are
 * keyed by leased inbound provider event + executing node id so a retry after
 * partial success recognizes business effects already committed.
 */
import crypto from "crypto";
import { addDays, format } from "date-fns";
import { basePrisma, prisma } from "./db";
import { customerRecordTenantId } from "./customerRecordTenant";
import { getDayAvailability, reserveSlot } from "./bookingSlots";
import { createIntakeLead } from "./leadIntake";
import { createLeadRecordIfPipelineReady } from "./leadCreate";
import { sendPushToAll } from "./push";
import { resolveTenantActor } from "./tenantActor";
import { currentInboundBotEventId } from "./botInboundEvent";
import { cancelBotBooking, lookupBotBooking, rescheduleBotBooking } from "./botBookingSelfService";
import { matchByPhone, waDigits } from "./whatsapp";
import { enrollEntityInJourney } from "./journeyDirectEnrollment";
import { flowRuntimeTools } from "./flowRuntimeTools";
import { flowContactCard } from "./flowContactCard";
import { runtimeFlowTenantId } from "./flowScope";

type Match = { contactId: string | null; leadId: string | null };
import type { ActionOutcome, FlowNode, JourneyFollowUp } from "./flow";
import { logAudit } from "./audit";
import { notifyStaffFromFlow } from "./flowNotify";

/** How a person reads the channel: "WhatsApp", not "whatsapp". */
const channelLabel = (source: string) => ({ whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", telegram: "Telegram" } as Record<string, string>)[source] ?? source;

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
    /*
     * THE PHONE HALF MATCHES ON DIGITS, NOT ON THE EXACT STRING.
     *
     * `findFirst({ where: { OR: [{ phone }, { email }] } })` compared the typed
     * phone with `=`. A customer who answers "0821234567" for a contact stored
     * as "+27 82 123 4567" is the same person by every human standard and a
     * different one by that test — so the booking flow created a duplicate
     * Contact and hung the appointment off it, splitting one customer's history
     * in two. This runs immediately before every service booking, demo and
     * journey enrolment, so it was the single most duplicating lookup we had.
     *
     * `matchByPhone` already resolves an inbound number properly; reusing it
     * here means the chatbot and the webhook agree about who somebody is
     * instead of each deciding separately.
     */
    const typedPhone = vars.phone ? await matchByPhone(waDigits(vars.phone)) : null;
    if (typedPhone?.contactId) return { contactId: typedPhone.contactId, leadId: match.leadId };
    const existing = vars.email
      ? await prisma.contact.findFirst({ where: { email: vars.email } })
      : null;
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

async function createDemo(source: string, vars: Record<string, string>, match: Match, nodeId: string): Promise<ActionOutcome> {
  const userId = await firstUserId();
  // No user to own the record. Returning silently made the flow tell the customer
  // "I've sent your demo request to the team" when nothing had been created.
  if (!userId) return { ok: false, reason: "No CRM user is available to own the request" };
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
  // createLeadRecordIfPipelineReady returns null when no pipeline stage exists.
  if (!lead) return { ok: false, reason: "No pipeline stage is configured to receive the request" };
  // An existing marker means a retry of an effect that already happened: success.
  if (await activityAlreadyExists(marker)) return { ok: true };
  await prisma.activity.create({
    data: {
      type: "test_drive", summary: `Test drive — ${vars.model || "cart"}`,
      note: appendMarker([vars.model ? `Model: ${vars.model}` : null, vars.date ? `Preferred: ${vars.date}` : null, ...fileLines(vars)], marker),
      location: vars.location || null, dueDate: new Date(), status: "planned", leadId: lead.id, contactId: who.contactId,
      assignedToId: userId, createdById: userId,
      tenantId: await customerRecordTenantId({ contactId: who.contactId, leadId: lead.id }),
    },
  });
  return { ok: true };
}

/**
 * UPDATE THE CRM from a flow step (Sean, 2026-11-02): tag the customer, set their salesperson, or move their open
 * deal to a stage. In the conversation's own workspace (the channel scope), each audited as the chatbot. A stage move
 * needs exactly ONE open deal — with several, it fails rather than guess which (single-customer-timeline rule).
 */
async function updateCrmFromFlow(node: Extract<FlowNode, { type: "crm" }>, match: Match): Promise<ActionOutcome> {
  const tenantId = runtimeFlowTenantId();
  const audit = (summary: string, ids: { contactId?: string | null; leadId?: string | null }, action = "chatbot.crm_update") =>
    logAudit({ action, summary, userName: "Chatbot", actorType: "system", source: "chatbot", ...ids }).catch(() => {});
  if (!match.contactId && !match.leadId) return { ok: false, reason: "No customer record for this conversation yet" };

  if (node.action === "tag") {
    const name = (node.tagName ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name || !match.contactId) return { ok: false, reason: !name ? "No tag chosen" : "No customer record to tag" };
    const tag = await prisma.tag.upsert({ where: { tenantId_name: { tenantId, name } }, create: { tenantId, name }, update: {}, select: { id: true } });
    await prisma.contact.update({ where: { id: match.contactId }, data: { tags: { connect: { id: tag.id } } } });
    await audit(`Tagged “${name}” by the chatbot`, { contactId: match.contactId });
    return { ok: true };
  }

  if (node.action === "assign") {
    const member = node.userId ? await basePrisma.tenantMember.findFirst({ where: { tenantId, userId: node.userId }, select: { userId: true } }) : null;
    if (!member) return { ok: false, reason: "That salesperson is no longer in this workspace" };
    if (match.contactId) await prisma.contact.updateMany({ where: { id: match.contactId, tenantId }, data: { ownerId: member.userId } });
    const deal = await openDeal(match, tenantId);
    if (deal) await prisma.lead.updateMany({ where: { id: deal.id, tenantId }, data: { assignedToId: member.userId } });
    await audit(`Set to ${node.userLabel ?? "a salesperson"} by the chatbot`, { contactId: match.contactId, leadId: deal?.id ?? null });
    return { ok: true };
  }

  // Move the open deal to a stage.
  const stage = node.stageId ? await prisma.pipelineStage.findFirst({ where: { id: node.stageId, tenantId }, select: { id: true, name: true } }) : null;
  if (!stage) return { ok: false, reason: "That stage no longer exists" };
  const deals = await openDeals(match, tenantId);
  if (deals.length !== 1) return { ok: false, reason: deals.length ? "The customer has more than one open deal" : "The customer has no open deal" };
  const [deal] = deals;
  if (deal.stageId !== stage.id) {
    await prisma.lead.updateMany({ where: { id: deal.id, tenantId }, data: { stageId: stage.id, stageEnteredAt: new Date() } });
    await audit(`Moved “${deal.title}” to ${stage.name} (chatbot)`, { contactId: match.contactId, leadId: deal.id }, "lead.stage_changed");
  }
  return { ok: true };
}

/**
 * ALL the customer's open deals, so "exactly one" really means one. A matched
 * open lead alone is not enough: its customer may have others, and the stage
 * move must refuse then rather than guess. A lead with no customer is its own list.
 */
async function openDeals(match: Match, tenantId: string): Promise<{ id: string; title: string; stageId: string }[]> {
  const select = { id: true, title: true, stageId: true } as const;
  const lead = match.leadId
    ? await prisma.lead.findFirst({ where: { id: match.leadId, tenantId, status: "open", deletedAt: null }, select: { ...select, contactId: true } })
    : null;
  const contactId = lead?.contactId ?? match.contactId;
  if (!contactId) return lead ? [{ id: lead.id, title: lead.title, stageId: lead.stageId }] : [];
  return prisma.lead.findMany({ where: { contactId, tenantId, status: "open", deletedAt: null }, select, take: 3 });
}
async function openDeal(match: Match, tenantId: string) {
  const deals = await openDeals(match, tenantId);
  return deals.length === 1 ? deals[0] : null;
}

export function crmActions(source: string, match: Match) {
  return {
    // Knowledge, AI-extract, outbound HTTPS and subflow loading — the runtime
    // half lives in flowRuntimeTools so the simulator can supply non-networking
    // stand-ins for exactly the same FlowCtx surface.
    ...flowRuntimeTools(),
    // The conversation's own workspace (the channel scope), the same one the flow came from.
    contactCard: (staffUserId: string | undefined) => flowContactCard(runtimeFlowTenantId(), staffUserId),
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
    startJourney: async (journeyId: string, vars: Record<string, string>, nodeId: string, followUp?: JourneyFollowUp): Promise<{ ok: boolean; reason?: string }> => {
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
        // The conversation it came from: the channel and the step, never what was said (that is the handOver list).
        payload: { channel: source, flowNodeId: nodeId },
        delayMinutes: followUp?.delayMinutes,
        handOver: followUp?.handOver,
      });
      vars.journey_started = result.ok ? "yes" : "no";
      vars.journey_reason = result.reason;
      if (result.runId) vars.journey_run_id = result.runId;
      return { ok: result.ok, reason: result.reason };
    },
    updateCrm: (node: Extract<FlowNode, { type: "crm" }>) => updateCrmFromFlow(node, match),
    // The provider event + step: a redelivered message tells nobody twice (PR #982 review).
    notifyStaff: (input: { userId: string; text: string; nodeId: string }) => notifyStaffFromFlow(channelLabel(source), { ...input, dedupeKey: botActionKey(input.nodeId, "notify") }, match),
    createBooking: async (vars: Record<string, string>, action: "service" | "demo" | "lead" | undefined, nodeId: string): Promise<ActionOutcome> => {
      if (action === "demo") return createDemo(source, vars, match, nodeId);
      if (action === "lead") {
        await createIntakeLead({ name: vars.name || `${source} enquiry`, email: vars.email || null, phone: vars.phone || null, message: vars.service || vars.message || "Chatbot enquiry", source, externalId: botActionKey(nodeId, "lead") });
        return { ok: true };
      }
      const userId = await firstUserId();
      if (!userId) return { ok: false, reason: "No CRM user is available to own the request" };
      const key = botActionKey(nodeId, "service");
      const marker = botActionMarker(key);
      // Already created by an earlier attempt of this same event — a success.
      if (await activityAlreadyExists(marker)) return { ok: true };
      const who = await ensureContact(source, vars, match);
      await prisma.activity.create({
        data: {
          type: "todo", category: "workshop", summary: `Service request (${source}) — ${vars.name || "customer"}`,
          note: appendMarker([vars.service ? `Needs: ${vars.service}` : null, vars.date ? `Preferred: ${vars.date}` : null, ...fileLines(vars)], marker),
          dueDate: new Date(), status: "planned", contactId: who.contactId, leadId: who.leadId, assignedToId: userId, createdById: userId,
          tenantId: await customerRecordTenantId({ contactId: who.contactId, leadId: who.leadId }),
        },
      });
      await sendPushToAll({ title: "New service request 🔧", body: vars.name || "Customer", url: who.contactId ? `/contacts/${who.contactId}` : "/inbox" }, "bot_handoff").catch(() => {});
      return { ok: true };
    },
  };
}
