/**
 * CRM-connected flow actions shared by every channel adapter.
 * Side effects are keyed by the leased inbound provider event + flow node id so
 * a retry after partial success can recognize the effect it already committed.
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

function actionKey(nodeId: string, kind: string): string | null {
  const eventId = currentInboundBotEventId();
  return eventId ? `bot:${eventId}:${nodeId}:${kind}` : null;
}

function actionMarker(key: string | null, suffix = "effect"): string | null {
  if (!key) return null;
  const digest = crypto.createHash("sha256").update(`${key}:${suffix}`).digest("hex").slice(0, 32);
  return `[bot-action:${digest}]`;
}

function appendMarker(lines: Array<string | null | undefined>, marker: string | null): string | null {
  return [...lines, marker].filter(Boolean).join("\n") || null;
}

async function ensureContact(source: string, vars: Record<string, string>, match: Match): Promise<Match> {
  if (match.contactId) return match;
  if (!(vars.name || vars.phone || vars.email)) return match;

  // The default booking flow captures a phone number. Reuse that identity on a
  // retry (or on a second flow action in the same conversation) rather than
  // creating another Contact before the idempotent Activity/Lead check runs.
  const identity = [
    vars.phone ? { phone: vars.phone } : null,
    vars.email ? { email: vars.email } : null,
  ].filter(Boolean) as Array<{ phone: string } | { email: string }>;
  if (identity.length) {
    const existing = await prisma.contact.findFirst({ where: { OR: identity } });
    if (existing) return { contactId: existing.id, leadId: match.leadId };
  }

  const [first, ...rest] = (vars.name || "Customer").trim().split(/\s+/);
  const c = await prisma.contact.create({
    data: {
      firstName: first || "Customer",
      lastName: rest.join(" ") || null,
      phone: vars.phone || null,
      email: vars.email || null,
      source,
    },
  });
  return { contactId: c.id, leadId: match.leadId };
}

async function firstUserId(): Promise<string | null> {
  return (await resolveTenantActor())?.id ?? null;
}

function fileLines(vars: Record<string, string>): string[] {
  return Object.values(vars).filter((v) => /^https?:\/\//.test(v)).map((v) => `Attachment: ${v}`);
}

async function activityAlreadyExists(marker: string | null) {
  if (!marker) return null;
  return prisma.activity.findFirst({ where: { note: { contains: marker } } });
}

async function createDemo(source: string, vars: Record<string, string>, match: Match, nodeId: string) {
  const userId = await firstUserId();
  if (!userId) return;
  const key = actionKey(nodeId, "demo");
  const marker = actionMarker(key);
  const who = await ensureContact(source, vars, match);

  const title = `Demo / test drive — ${vars.name || "customer"}`;
  const lead = await createLeadRecordIfPipelineReady({
    title,
    name: vars.name || "Customer",
    phone: vars.phone || null,
    email: vars.email || null,
    source,
    contactId: who.contactId,
    externalId: key,
    audit: {
      action: "lead.received",
      summary: `Lead “${title}” created from a ${source} demo / test-drive request`,
      userName: "System",
    },
    push: { title: "Demo / test-drive request 🚗", body: vars.name || "Customer", kind: "bot_handoff" },
  });
  if (!lead) return;

  if (await activityAlreadyExists(marker)) return;
  await prisma.activity.create({
    data: {
      type: "test_drive",
      summary: `Test drive — ${vars.model || "cart"}`,
      note: appendMarker([
        vars.model ? `Model: ${vars.model}` : null,
        vars.date ? `Preferred: ${vars.date}` : null,
        ...fileLines(vars),
      ], marker),
      location: vars.location || null,
      dueDate: new Date(),
      status: "planned",
      leadId: lead.id,
      contactId: who.contactId,
      assignedToId: userId,
      createdById: userId,
    },
  });
}

export function crmActions(source: string, match: Match) {
  return {
    availableSlots: () => availableSlots(),

    bookSlot: async (
      slotId: string,
      vars: Record<string, string>,
      nodeId: string,
    ): Promise<{ ok: boolean; label?: string }> => {
      const [date, time] = slotId.split("_");
      const userId = await firstUserId();
      if (!userId || !date || !time) return { ok: false };
      const key = actionKey(nodeId, "slot");
      const marker = actionMarker(key);
      const label = format(new Date(`${date}T${time}:00`), "EEE d MMM · HH:mm");
      const existing = await activityAlreadyExists(marker);
      if (existing) return { ok: true, label };

      const who = await ensureContact(source, vars, match);
      try {
        await reserveSlot({
          date,
          time,
          summary: `Service booking (${source}) — ${vars.name || "customer"}${vars.service ? `: ${vars.service}` : ""}`,
          note: vars.service ? `Needs: ${vars.service}` : null,
          contactId: who.contactId,
          leadId: who.leadId,
          userId,
          dedupeMarker: marker,
        });
        await sendPushToAll({ title: "New service booking 🔧", body: `${vars.name || "Customer"} — ${label}`, url: who.contactId ? `/contacts/${who.contactId}` : "/workshop-calendar" }, "bot_handoff").catch(() => {});
        return { ok: true, label };
      } catch {
        return { ok: false };
      }
    },

    createBooking: async (
      vars: Record<string, string>,
      action: "service" | "demo" | "lead" | undefined,
      nodeId: string,
    ) => {
      if (action === "demo") return createDemo(source, vars, match, nodeId);

      if (action === "lead") {
        const key = actionKey(nodeId, "lead");
        await createIntakeLead({
          name: vars.name || `${source} enquiry`,
          email: vars.email || null,
          phone: vars.phone || null,
          message: vars.service || vars.message || "Chatbot enquiry",
          source,
          externalId: key,
        });
        return;
      }

      const userId = await firstUserId();
      if (!userId) return;
      const key = actionKey(nodeId, "service");
      const marker = actionMarker(key);
      if (await activityAlreadyExists(marker)) return;

      const who = await ensureContact(source, vars, match);
      await prisma.activity.create({
        data: {
          type: "todo",
          category: "workshop",
          summary: `Service request (${source}) — ${vars.name || "customer"}`,
          note: appendMarker([
            vars.service ? `Needs: ${vars.service}` : null,
            vars.date ? `Preferred: ${vars.date}` : null,
            ...fileLines(vars),
          ], marker),
          dueDate: new Date(),
          status: "planned",
          contactId: who.contactId,
          leadId: who.leadId,
          assignedToId: userId,
          createdById: userId,
        },
      });
      await sendPushToAll({ title: "New service request 🔧", body: vars.name || "Customer", url: who.contactId ? `/contacts/${who.contactId}` : "/inbox" }, "bot_handoff").catch(() => {});
    },
  };
}
