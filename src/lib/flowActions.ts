/**
 * CRM-connected flow actions shared by every channel adapter: real workshop
 * availability, atomic slot booking, demo/test-drive creation and lead capture
 * — all writing straight into the CRM (no guessing).
 */
import { addDays, format } from "date-fns";
import { prisma } from "./db";
import { getDayAvailability, reserveSlot } from "./bookingSlots";
import { createIntakeLead } from "./leadIntake";
import { createLeadRecordIfPipelineReady } from "./leadCreate";
import { sendPushToAll } from "./push";
import { resolveTenantActor } from "./tenantActor";

type Match = { contactId: string | null; leadId: string | null };

/** Next open workshop slots (scans the availability engine, real capacity). */
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

async function ensureContact(source: string, vars: Record<string, string>, match: Match): Promise<Match> {
  if (match.contactId) return match;
  if (vars.name || vars.phone || vars.email) {
    const [first, ...rest] = (vars.name || "Customer").trim().split(/\s+/);
    const c = await prisma.contact.create({
      data: { firstName: first || "Customer", lastName: rest.join(" ") || null, phone: vars.phone || null, email: vars.email || null, source },
    });
    return { contactId: c.id, leadId: match.leadId };
  }
  return match;
}

async function firstUserId(): Promise<string | null> {
  // Tenant-aware (channel scope established by the webhook chokepoint); dormant →
  // the oldest active user, unchanged.
  return (await resolveTenantActor())?.id ?? null;
}

/** Captured file uploads (stored as URLs in variables) → note lines. */
function fileLines(vars: Record<string, string>): string[] {
  return Object.values(vars).filter((v) => /^https?:\/\//.test(v)).map((v) => `Attachment: ${v}`);
}

async function createDemo(source: string, vars: Record<string, string>, match: Match) {
  const userId = await firstUserId();
  if (!userId) return;
  const who = await ensureContact(source, vars, match);
  // Through the one lead creator. This path created the Lead row itself with no
  // audit entry, no `position` (so it sorted below every form lead) and no
  // `lead_created` automations at all — a bot test-drive request never triggered
  // the follow-up rule the workspace had configured for a new lead.
  //
  // The push stays the demo-specific one on the `bot_handoff` toggle rather than
  // the generic "New lead": it says more, staff already recognise it, and one
  // request should announce itself once. …IfPipelineReady keeps the old
  // `if (!stage) return` guard — no pipeline, no lead and no test-drive activity.
  const title = `Demo / test drive — ${vars.name || "customer"}`;
  const lead = await createLeadRecordIfPipelineReady({
    title,
    name: vars.name || "Customer",
    phone: vars.phone || null,
    email: vars.email || null,
    source,
    contactId: who.contactId,
    audit: {
      action: "lead.received",
      summary: `Lead “${title}” created from a ${source} demo / test-drive request`,
      userName: "System",
    },
    push: { title: "Demo / test-drive request 🚗", body: vars.name || "Customer", kind: "bot_handoff" },
  });
  if (!lead) return;
  await prisma.activity.create({
    data: {
      type: "test_drive",
      summary: `Test drive — ${vars.model || "cart"}`,
      note: [vars.model ? `Model: ${vars.model}` : null, vars.date ? `Preferred: ${vars.date}` : null, ...fileLines(vars)].filter(Boolean).join("\n") || null,
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

/** The CRM-connected parts of a FlowCtx for a given channel. */
export function crmActions(source: string, match: Match) {
  return {
    availableSlots: () => availableSlots(),
    bookSlot: async (slotId: string, vars: Record<string, string>): Promise<{ ok: boolean; label?: string }> => {
      const [date, time] = slotId.split("_");
      const userId = await firstUserId();
      if (!userId || !date || !time) return { ok: false };
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
        });
        const label = format(new Date(`${date}T${time}:00`), "EEE d MMM · HH:mm");
        await sendPushToAll({ title: "New service booking 🔧", body: `${vars.name || "Customer"} — ${label}`, url: who.contactId ? `/contacts/${who.contactId}` : "/workshop-calendar" }, "bot_handoff").catch(() => {});
        return { ok: true, label };
      } catch {
        return { ok: false };
      }
    },
    createBooking: async (vars: Record<string, string>, action?: "service" | "demo" | "lead") => {
      if (action === "demo") return createDemo(source, vars, match);
      if (action === "lead") {
        await createIntakeLead({ name: vars.name || `${source} enquiry`, email: vars.email || null, phone: vars.phone || null, message: vars.service || vars.message || "Chatbot enquiry", source }).catch(() => {});
        return;
      }
      // service without a booked slot → a workshop request the team confirms
      const userId = await firstUserId();
      if (!userId) return;
      const who = await ensureContact(source, vars, match);
      await prisma.activity.create({
        data: {
          type: "todo",
          category: "workshop",
          summary: `Service request (${source}) — ${vars.name || "customer"}`,
          note: [vars.service ? `Needs: ${vars.service}` : null, vars.date ? `Preferred: ${vars.date}` : null, ...fileLines(vars)].filter(Boolean).join("\n") || null,
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
