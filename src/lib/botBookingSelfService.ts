import "server-only";
import { format } from "date-fns";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";
import { cancelWorkshopBooking, rescheduleWorkshopBooking } from "./bookingSlots";
import { channelVerifiedOwner, markUnverified, type BotBookingMatch } from "./botBookingIdentity";

export type { BotBookingMatch };
export type BotBookingSummary = {
  id: string;
  label: string;
  summary: string;
  dueAt: Date;
};

function ownerWhere(owner: BotBookingMatch): { OR: ({ contactId: string } | { leadId: string })[] } | null {
  const OR: ({ contactId: string } | { leadId: string })[] = [];
  if (owner.contactId) OR.push({ contactId: owner.contactId });
  if (owner.leadId) OR.push({ leadId: owner.leadId });
  return OR.length ? { OR } : null;
}

export async function findUpcomingBotBooking(match: BotBookingMatch): Promise<BotBookingSummary | null> {
  const owner = channelVerifiedOwner(match);
  const scope = owner ? ownerWhere(owner) : null;
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

/** Populate deterministic flow variables used by the management template. */
export async function lookupBotBooking(
  match: BotBookingMatch,
  vars: Record<string, string>,
): Promise<{ ok: boolean; label?: string }> {
  // Say WHY there is no booking to show. "Not found" and "we cannot tell who you
  // are" need different words to the customer and different handling in the graph.
  if (!channelVerifiedOwner(match)) {
    vars.booking_found = "no";
    markUnverified(vars);
    return { ok: false };
  }
  vars.booking_identity = "verified";
  const booking = await findUpcomingBotBooking(match);
  if (!booking) {
    vars.booking_found = "no";
    delete vars.booking_id;
    delete vars.booking_slot;
    delete vars.booking_summary;
    return { ok: false };
  }
  vars.booking_found = "yes";
  vars.booking_id = booking.id;
  vars.booking_slot = booking.label;
  vars.booking_summary = booking.summary;
  return { ok: true, label: booking.label };
}

export async function cancelBotBooking(
  bookingId: string,
  match: BotBookingMatch,
  vars: Record<string, string>,
): Promise<{ ok: boolean; alreadyCancelled?: boolean; label?: string }> {
  const owner = channelVerifiedOwner(match);
  if (!owner) {
    vars.booking_cancelled = "no";
    markUnverified(vars);
    return { ok: false };
  }
  const result = await cancelWorkshopBooking({ bookingId, owner });
  if (!result.ok) {
    vars.booking_cancelled = "no";
    return { ok: false };
  }
  const label = result.dueDate ? format(result.dueDate, "EEE d MMM · HH:mm") : vars.booking_slot;
  vars.booking_cancelled = "yes";
  if (label) vars.booking_slot = label;

  if (!result.alreadyCancelled) {
    await logAudit({
      action: "workshop.booking_cancelled",
      summary: `Chatbot cancelled workshop booking “${result.summary ?? bookingId}”${label ? ` for ${label}` : ""}`,
      entityType: "Activity",
      entityId: bookingId,
      userName: "Chatbot",
    }).catch(() => {});
    await sendPushToAll({
      title: "Service booking cancelled",
      body: `${result.summary ?? "Workshop booking"}${label ? ` · ${label}` : ""}`.slice(0, 180),
      url: "/workshop-calendar",
    }, "bot_handoff").catch(() => {});
  }
  return { ok: true, alreadyCancelled: result.alreadyCancelled, label };
}

export async function rescheduleBotBooking(
  bookingId: string,
  slotId: string,
  match: BotBookingMatch,
  vars: Record<string, string>,
): Promise<{ ok: boolean; label?: string }> {
  const [date, time] = slotId.split("_");
  if (!bookingId || !date || !time) return { ok: false };
  const owner = channelVerifiedOwner(match);
  if (!owner) {
    vars.booking_rescheduled = "no";
    markUnverified(vars);
    return { ok: false };
  }
  try {
    const result = await rescheduleWorkshopBooking({ bookingId, date, time, owner });
    if (!result.ok || !result.dueDate) {
      vars.booking_rescheduled = "no";
      return { ok: false };
    }
    const label = format(result.dueDate, "EEE d MMM · HH:mm");
    vars.booking_rescheduled = "yes";
    vars.booking_slot = label;
    await logAudit({
      action: "workshop.booking_rescheduled",
      summary: `Chatbot moved workshop booking “${result.summary ?? bookingId}” to ${label}`,
      entityType: "Activity",
      entityId: bookingId,
      userName: "Chatbot",
    }).catch(() => {});
    await sendPushToAll({
      title: "Service booking rescheduled",
      body: `${result.summary ?? "Workshop booking"} · ${label}`.slice(0, 180),
      url: "/workshop-calendar",
    }, "bot_handoff").catch(() => {});
    return { ok: true, label };
  } catch (error) {
    if (error instanceof Error && (error.message === "SLOT_TAKEN" || error.message === "SLOT_INVALID")) return { ok: false };
    throw error;
  }
}
