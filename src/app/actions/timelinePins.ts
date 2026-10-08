"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import {
  canAccessContact,
  canAccessLead,
  requirePermission,
} from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { toggleTimelinePin } from "@/lib/timelinePins";
// asActionResult (which binds the acting workspace itself) so a refusal reaches
// the timeline as a message — a thrown Error showed "This page hit an error"
// (gap audit #22).
import { asActionResult, refuse } from "@/lib/actionResult";

export async function toggleActivityPin(id: string, path: string) {
  return asActionResult(async () => {
    const user = await requirePermission("activities.manage");
    const activity = await prisma.activity.findUnique({
      where: { id },
      include: { lead: true },
    });
    if (!activity) refuse("That activity is no longer there — refresh the page.");

    const directlyOwned =
      activity.assignedToId === user.id || activity.createdById === user.id;
    const linkedAllowed =
      (activity.leadId ? await canAccessLead(user, activity.leadId) : false) ||
      (activity.contactId
        ? await canAccessContact(user, activity.contactId)
        : false);
    if (user.role !== "owner" && !directlyOwned && !linkedAllowed) {
      refuse("You don't have access to that activity.");
    }

    const result = await toggleTimelinePin("activity", id, user.id);
    await logAudit({
      action: result.pinned ? "activity.pinned" : "activity.unpinned",
      summary: `${result.pinned ? "Pinned" : "Unpinned"} ${activity.type}: “${activity.summary}”`,
      leadId: activity.leadId,
      contactId: activity.contactId ?? activity.lead?.contactId,
      user,
    });
    revalidatePath(path);
    return { success: result.pinned ? "Pinned" : "Unpinned" };
  });
}

export async function toggleContactNotePin(contactId: string, path: string) {
  return asActionResult(async () => {
    const user = await requirePermission("contacts.edit");
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, firstName: true, lastName: true, notes: true },
    });
    if (!contact) refuse("That contact is no longer there — refresh the page.");

    if (user.role !== "owner" && !(await canAccessContact(user, contact.id))) {
      refuse("You don't have access to that contact.");
    }
    if (!contact.notes?.trim()) {
      refuse("This contact has no original note to pin.");
    }

    const result = await toggleTimelinePin("contact_note", contact.id, user.id);
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
    await logAudit({
      action: result.pinned ? "contact.note_pinned" : "contact.note_unpinned",
      summary: `${result.pinned ? "Pinned" : "Unpinned"} the original note for ${name || "contact"}`,
      contactId: contact.id,
      user,
    });
    revalidatePath(path);
    return { success: result.pinned ? "Pinned" : "Unpinned" };
  });
}

export async function toggleLeadNotePin(leadId: string, path: string) {
  return asActionResult(async () => {
    const user = await requirePermission("leads.edit");
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, title: true, notes: true, contactId: true },
    });
    if (!lead) refuse("That lead is no longer there — refresh the page.");

    if (user.role !== "owner" && !(await canAccessLead(user, lead.id))) {
      refuse("You don't have access to that lead.");
    }
    if (!lead.notes?.trim()) {
      refuse("This lead has no original note to pin.");
    }

    const result = await toggleTimelinePin("lead_note", lead.id, user.id);
    await logAudit({
      action: result.pinned ? "lead.note_pinned" : "lead.note_unpinned",
      summary: `${result.pinned ? "Pinned" : "Unpinned"} the original note for “${lead.title}”`,
      leadId: lead.id,
      contactId: lead.contactId,
      user,
    });
    revalidatePath(path);
    return { success: result.pinned ? "Pinned" : "Unpinned" };
  });
}
