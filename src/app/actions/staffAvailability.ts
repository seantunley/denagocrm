"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { resolveAssignableUser } from "@/lib/tenantActor";
import { actingTenantId } from "@/lib/actingTenant";
import { johannesburgMidnight, shiftDateKey } from "@/lib/calendarDates";
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

// The shared Johannesburg date helpers (lib/calendarDates.ts), wrapped so a
// malformed value becomes a form error rather than a throw.
function localDateTime(value: string | null): Date | null {
  if (!value) return null;
  try {
    const parsed = value.includes("T") ? new Date(`${value}:00+02:00`) : johannesburgMidnight(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

function nextJohannesburgDay(dateKey: string): Date | null {
  try {
    return johannesburgMidnight(shiftDateKey(dateKey, 1));
  } catch {
    return null;
  }
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
    start = startDate ? localDateTime(startDate) : null;
    end = endDate ? nextJohannesburgDay(endDate) : null;
  } else {
    start = localDateTime(text(formData, "startAt"));
    end = localDateTime(text(formData, "endAt"));
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
