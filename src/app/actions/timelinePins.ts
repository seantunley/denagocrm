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
