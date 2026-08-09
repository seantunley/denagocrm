import "server-only";
import { format } from "date-fns";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";

export type BotBookingMatch = { contactId: string | null; leadId: string | null };
export type BotBookingSummary = {
  id: string;
  label: string;
  summary: string;
  dueAt: Date;
};

function phoneTail(phone: string | null | undefined): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : null;
}

async function resolveBookingOwner(
  match: BotBookingMatch,
  vars: Record<string, string>,
): Promise<BotBookingMatch> {
  if (match.contactId || match.leadId) return match;
  const tail = phoneTail(vars.phone);
  if (!tail) return match;

  const contact = await prisma.contact.findFirst({
    where: {
      OR: [
        { phone: { contains: tail } },
        { whatsapp: { contains: tail } },
      ],
    },
    select: { id: true },
  });
  if (contact) return { contactId: contact.id, leadId: null };

  const lead = await prisma.lead.findFirst({
    where: { phone: { contains: tail }, status: "open" },
    select: { id: true, contactId: true },
  });
  return lead ? { contactId: lead.contactId ?? null, leadId: lead.id } : match;
}

function ownerWhere(owner: BotBookingMatch): { OR: ({ contactId: string } | { leadId: string })[] } | null {
  const OR: ({ contactId: string } | { leadId: string })[] = [];
  if (owner.contactId) OR.push({ contactId: owner.contactId });
  if (owner.leadId) OR.push({ leadId: owner.leadId });
  return OR.length ? { OR } : null;
}

/**
 * Find the customer's next live workshop reservation. We deliberately do not
 * create a contact while looking something up: a failed lookup must be read-only.
 */
export async function findUpcomingBotBooking(
  match: BotBookingMatch,
  vars: Record<string, string>,
): Promise<BotBookingSummary | null> {
  const owner = await resolveBookingOwner(match, vars);
  const scope = ownerWhere(owner);
  if (!scope) return null;

  const activity = await prisma.activity.findFirst({
    where: {
      category: "workshop",
      status: "planned",
      dueDate: { gte: new Date() },
      ...scope,
    },
    orderBy: { dueDate: "asc" },
    select: { id: true, summary: true, dueDate: true },
  });
  if (!activity?.dueDate) return null;
  return {
    id: activity.id,
    summary: activity.summary,
    dueAt: activity.dueDate,
    label: format(activity.dueDate, "EEE d MMM · HH:mm"),
  };
}

/**
 * Cancel only a future PLANNED workshop activity belonging to this conversation's
 * customer. History is retained with status=cancelled; the workshop capacity
 * engine counts planned rows only, so cancellation releases the slot without
 * deleting the audit trail.
 *
 * Idempotent by construction: a retry sees no matching planned row and returns
 * `alreadyCancelled=true` when the same activity is now cancelled.
 */
export async function cancelBotBooking(
  bookingId: string,
  match: BotBookingMatch,
  vars: Record<string, string>,
): Promise<{ ok: boolean; alreadyCancelled?: boolean; label?: string }> {
  const owner = await resolveBookingOwner(match, vars);
  const scope = ownerWhere(owner);
  if (!scope || !bookingId) return { ok: false };

  const existing = await prisma.activity.findFirst({
    where: {
      id: bookingId,
      category: "workshop",
      dueDate: { gte: new Date() },
      ...scope,
    },
    select: { id: true, summary: true, status: true, dueDate: true },
  });
  if (!existing?.dueDate) return { ok: false };
  const label = format(existing.dueDate, "EEE d MMM · HH:mm");
  if (existing.status === "cancelled") return { ok: true, alreadyCancelled: true, label };
  if (existing.status !== "planned") return { ok: false };

  const updated = await prisma.activity.updateMany({
    where: {
      id: existing.id,
      status: "planned",
      category: "workshop",
      dueDate: { gte: new Date() },
      ...scope,
    },
    data: { status: "cancelled" },
  });
  if (updated.count !== 1) {
    // A concurrent cancellation is success, not an error. Re-read only this
    // customer-owned booking before deciding.
    const after = await prisma.activity.findFirst({
      where: { id: existing.id, category: "workshop", ...scope },
      select: { status: true },
    });
    return after?.status === "cancelled" ? { ok: true, alreadyCancelled: true, label } : { ok: false };
  }

  await logAudit({
    action: "workshop.booking_cancelled",
    summary: `Chatbot cancelled workshop booking “${existing.summary}” for ${label}`,
    entityType: "Activity",
    entityId: existing.id,
    userName: "Chatbot",
  }).catch(() => {});
  await sendPushToAll({
    title: "Service booking cancelled",
    body: `${existing.summary} · ${label}`.slice(0, 180),
    url: "/workshop-calendar",
  }, "bot_handoff").catch(() => {});
  return { ok: true, label };
}
