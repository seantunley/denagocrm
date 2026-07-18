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

export async function toggleActivityPin(id: string, path: string) {
  const user = await requirePermission("activities.manage");
  const activity = await prisma.activity.findUniqueOrThrow({
    where: { id },
    include: { lead: true },
  });

  const directlyOwned =
    activity.assignedToId === user.id || activity.createdById === user.id;
  const linkedAllowed =
    (activity.leadId ? await canAccessLead(user, activity.leadId) : false) ||
    (activity.contactId
      ? await canAccessContact(user, activity.contactId)
      : false);
  if (user.role !== "owner" && !directlyOwned && !linkedAllowed) {
    throw new Error("Activity access denied");
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
}

export async function toggleContactNotePin(contactId: string, path: string) {
  const user = await requirePermission("contacts.edit");
  const contact = await prisma.contact.findUniqueOrThrow({
    where: { id: contactId },
    select: { id: true, firstName: true, lastName: true, notes: true },
  });

  if (user.role !== "owner" && !(await canAccessContact(user, contact.id))) {
    throw new Error("Contact access denied");
  }
  if (!contact.notes?.trim()) {
    throw new Error("This contact has no original note to pin");
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
}

export async function toggleLeadNotePin(leadId: string, path: string) {
  const user = await requirePermission("leads.edit");
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    select: { id: true, title: true, notes: true, contactId: true },
  });

  if (user.role !== "owner" && !(await canAccessLead(user, lead.id))) {
    throw new Error("Lead access denied");
  }
  if (!lead.notes?.trim()) {
    throw new Error("This lead has no original note to pin");
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
}
