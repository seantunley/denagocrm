"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { resolveAssignableUser } from "@/lib/tenantActor";
import { actingTenantId } from "@/lib/actingTenant";
import { logAudit } from "@/lib/audit";
import {
  commitmentConflictMessage,
  findStaffCommitmentConflict,
  lockStaffSchedules,
} from "@/lib/staffAvailability";

const text = (formData: FormData, key: string) => {
  const value = String(formData.get(key) ?? "").trim();
  return value || null;
};

function localDateTime(value: string | null, label: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value.includes("T") ? `${value}:00+02:00` : `${value}T00:00:00+02:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function nextJohannesburgDay(dateKey: string): Date | null {
  const start = new Date(`${dateKey}T00:00:00+02:00`);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

export async function createStaffAvailability(
  formData: FormData,
): Promise<{ error?: string; success?: string }> {
  const user = await requirePermission("activities.manage");
  const assignee = await resolveAssignableUser(formData.get("assignedToId"), "team member");
  const assignedTo = assignee ?? user;
  const summary = text(formData, "summary") ?? "Unavailable";
  const note = text(formData, "note");
  if (!note) return { error: "Add a note explaining why this time is unavailable." };

  const allDay = formData.get("allDay") === "on";
  let start: Date | null;
  let end: Date | null;

  if (allDay) {
    const startDate = text(formData, "startDate");
    const endDate = text(formData, "endDate") ?? startDate;
    start = startDate ? localDateTime(startDate, "Start date") : null;
    end = endDate ? nextJohannesburgDay(endDate) : null;
  } else {
    start = localDateTime(text(formData, "startAt"), "Start time");
    end = localDateTime(text(formData, "endAt"), "End time");
  }

  if (!start || !end) return { error: allDay ? "Choose valid start and end dates." : "Choose valid start and end times." };
  if (end <= start) return { error: "End must be after the start." };

  const tenantId = await actingTenantId();
  const result = await prisma.$transaction(async (tx) => {
    await lockStaffSchedules(tx, tenantId, [assignedTo.id]);
    const conflict = await findStaffCommitmentConflict({
      userId: assignedTo.id,
      tenantId,
      start,
      end,
      db: tx,
    });
    if (conflict) return { conflict } as const;

    const activity = await tx.activity.create({
      data: {
        type: "availability",
        category: null,
        summary,
        note,
        dueDate: start,
        endDate: end,
        allDay,
        availabilityBlock: true,
        status: "planned",
        assignedToId: assignedTo.id,
        createdById: user.id,
        tenantId,
      },
    });
    return { activity } as const;
  });

  if ("conflict" in result && result.conflict) {
    return { error: commitmentConflictMessage(result.conflict) };
  }

  await logAudit({
    action: "activity.availability_blocked",
    summary: `Blocked ${assignedTo.name}'s calendar: ${summary} — ${note}`,
    user,
  });
  revalidatePath("/calendar");
  revalidatePath("/activities");
  revalidatePath("/");
  return { success: "Availability blocked" };
}
