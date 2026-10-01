"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import {
  canAccessContact,
  canAccessLead,
  requirePermission,
  type PermissionUser,
} from "@/lib/permissions";
import { requireUser } from "@/lib/auth";
import { futureActivityRefusal, isFutureDay } from "@/lib/activityDay";
import { resolveAssignableUser } from "@/lib/tenantActor";
import { logAudit } from "@/lib/audit";
import { reserveSlot } from "@/lib/bookingSlots";
import { ensureTimelinePin } from "@/lib/timelinePins";
import {
  availabilityConflictMessage,
  commitmentConflictMessage,
  DEFAULT_ACTIVITY_DURATION_MS,
  effectiveActivityEnd,
  findStaffAvailabilityConflict,
  findStaffCommitmentConflict,
  lockStaffSchedules,
} from "@/lib/staffAvailability";
import {
  FOLLOW_UP_TYPE,
  ensureFollowUpTime,
  followUpDueDateError,
  followUpValidationError,
} from "@/lib/followUp";

const str = (formData: FormData, key: string) => {
  const value = String(formData.get(key) ?? "").trim();
  return value === "" ? null : value;
};

/**
 * Who this activity may be assigned to — through the shared contract, not off
 * the form.
 *
 * This was the half of the fix that was missing. The picker feeding these two
 * actions is the one on the contact and lead detail pages, and BOTH ends were
 * unscoped: the dropdown listed every `User` row on the platform, and the action
 * behind it wrote `str(formData, "assignedToId") ?? user.id` with nothing
 * looking the person up at all. Not even the weak "does this user exist" check
 * the help desk had — a posted id from another workspace went straight onto this
 * workspace's activity, and from there into its audit line, its reminder push
 * and the assignee's own task list.
 *
 * Worth noting how it hid: `scheduleQuickActivity` in quickCreate.ts DID check
 * membership before delegating here, so the quick-create path was safe while the
 * ordinary one was not. That is exactly the divergence four private copies of a
 * rule produce, and the reason this now has one home.
 *
 * Blank means "assign it to me", which is what the `?? user.id` fallback always
 * meant and what the select's `defaultValue={currentUserId}` still submits.
 */
async function resolveActivityAssignee(formData: FormData) {
  return resolveAssignableUser(formData.get("assignedToId"), "team member");
}

// Refresh the lead/contact detail pages whose overdue/pending state depends on
// an activity, so completing/cancelling/rescheduling from ANY surface updates
// the record's Live timeline.
function revalidateRecordPages(activity: {
  leadId: string | null;
  contactId: string | null;
  lead?: { contactId: string | null } | null;
}) {
  if (activity.leadId) revalidatePath(`/leads/${activity.leadId}`);
  const contactId = activity.contactId ?? activity.lead?.contactId;
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

async function assertLinks(
  user: PermissionUser,
  links: { leadId?: string | null; contactId?: string | null },
) {
  if (links.leadId && !(await canAccessLead(user, links.leadId))) {
    throw new Error("Lead access denied");
  }
  if (links.contactId && !(await canAccessContact(user, links.contactId))) {
    throw new Error("Contact access denied");
  }
}

async function requireActivityAccess(id: string) {
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
  return { user, activity };
}

export async function scheduleActivity(formData: FormData): Promise<{ error?: string; success?: string }> {
  const user = await requirePermission("activities.manage");
  const summary = String(formData.get("summary") ?? "").trim();
  if (!summary) return { error: "What needs to happen is required." };
  const leadId = str(formData, "leadId");
  const contactId = str(formData, "contactId");
  await assertLinks(user, { leadId, contactId });

  const rawDue = str(formData, "dueDate");
  const rawEnd = str(formData, "endDate");
  const type = str(formData, "type") ?? "todo";
  const note = str(formData, "note");
  const location = str(formData, "location");
  const assignee = await resolveActivityAssignee(formData);
  const assignedToId = assignee?.id ?? user.id;
  const workshop = formData.get("workshop") === "on";

  let dueDate: Date;
  if (type === FOLLOW_UP_TYPE) {
    dueDate = rawDue
      ? new Date(`${ensureFollowUpTime(rawDue)}:00+02:00`)
      : new Date(NaN);
    const problem = followUpValidationError({ note, dueDate }, new Date());
    if (problem) return { error: problem };
  } else {
    dueDate = rawDue
      ? rawDue.includes("T")
        ? new Date(`${rawDue}:00+02:00`)
        : new Date(rawDue)
      : new Date();
  }
  if (Number.isNaN(dueDate.getTime())) return { error: "Pick a valid start date and time." };

  const endDate = rawEnd
    ? new Date(rawEnd.includes("T") ? `${rawEnd}:00+02:00` : rawEnd)
    : new Date(dueDate.getTime() + DEFAULT_ACTIVITY_DURATION_MS);
  if (Number.isNaN(endDate.getTime()) || endDate <= dueDate) {
    return { error: "End time must be after the start time." };
  }

  let activity;
  if (workshop) {
    if (!rawDue || !rawDue.includes("T")) {
      return { error: "Pick a configured workshop date and time." };
    }
    try {
      activity = await reserveSlot({
        date: rawDue.slice(0, 10),
        time: rawDue.slice(11, 16),
        summary,
        note,
        location,
        type,
        contactId,
        leadId,
        assignedToId,
        endDate,
        userId: user.id,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "SLOT_TAKEN") {
        return { error: "That workshop time has just filled up. Pick another available slot." };
      }
      if (code === "SLOT_INVALID") {
        return { error: "That workshop slot is no longer available. Pick a future configured date and time." };
      }
      if (code.startsWith("STAFF_UNAVAILABLE:")) {
        return { error: code.slice("STAFF_UNAVAILABLE:".length) };
      }
      throw error;
    }
  } else {
    const tenantId = await customerRecordTenantId({ contactId, leadId });
    activity = await prisma.$transaction(async (tx) => {
      await lockStaffSchedules(tx, tenantId ?? "global", [assignedToId]);
      const conflict = await findStaffAvailabilityConflict({
        userId: assignedToId,
        start: dueDate,
        end: endDate,
        db: tx,
      });
      if (conflict) return { conflict } as const;
      const created = await tx.activity.create({
        data: {
          type,
          category: null,
          summary,
          note,
          dueDate,
          endDate,
          location,
          leadId,
          contactId,
          assignedToId,
          createdById: user.id,
          tenantId,
        },
      });
      return { created } as const;
    });
    if ("conflict" in activity && activity.conflict) {
      return { error: availabilityConflictMessage(activity.conflict) };
    }
    activity = activity.created;
  }

  if (activity.type === FOLLOW_UP_TYPE) {
    await ensureTimelinePin("activity", activity.id, user.id);
  }

  const assigneeName = assignee?.name ?? user.name;
  await logAudit({
    action: "activity.scheduled",
    summary: `Scheduled ${activity.type}: “${summary}”${activity.location ? ` at ${activity.location}` : ""} — assigned to ${assigneeName}`,
    leadId,
    contactId,
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/activities"));
  revalidatePath("/activities");
  revalidatePath("/calendar");
  revalidatePath("/");
  return { success: "Activity scheduled" };
}

async function finishActivity(id: string, note: string) {
  const { user, activity: scheduled } = await requireActivityAccess(id);
  /*
   * THE ONE CHOKEPOINT. Six places in the UI offer a "done" control — the two
   * activity lists, the lead timeline, the activity panel, the calendar and the
   * dashboard agenda — and every one of them arrives here, through either
   * `completeActivity` or `completeActivityAssess`. Guarding here covers all of
   * them; guarding in a component covers one and invites the next one to forget.
   *
   * Completing work scheduled for a day that has not started is not a typo the
   * user meant: it silently inflates completion stats, marks a lead as followed
   * up when nobody called, and removes the item from tomorrow's agenda so it
   * never gets done.
   *
   * NOT applied to `testDrives.ts`, which also sets an activity done. That path
   * records a test drive actually being RETURNED — a real-world event that has
   * happened — rather than a person ticking a box early, and refusing it would
   * block the return being logged.
   */
  if (isFutureDay(scheduled.dueDate)) {
    throw new Error(futureActivityRefusal(scheduled.dueDate));
  }
  const activity = await prisma.activity.update({
    where: { id },
    data: { status: "done", doneAt: new Date() },
    include: { lead: true },
  });
  await logAudit({
    action: "activity.done",
    summary: `Completed ${activity.type}: ${activity.summary}`,
    contactId: activity.contactId ?? activity.lead?.contactId,
    leadId: activity.leadId,
    user,
  });
  const trimmed = note.trim();
  if (trimmed) {
    await prisma.communication.create({
      data: {
        type: activity.type === "todo" ? "note" : activity.type,
        direction: "outbound",
        subject: `Activity done: ${activity.summary}`,
        body: trimmed,
        leadId: activity.leadId,
        contactId: activity.contactId,
        userId: user.id,
        tenantId: await customerRecordTenantId({ contactId: activity.contactId, leadId: activity.leadId }),
      },
    });
  }
  /*
   * NO REVALIDATION HERE — the caller decides when it is safe.
   *
   * This used to call revalidateRecordPages(activity), which quietly defeated
   * the deferral in completeActivityAssess below. `revalidatePath` in a Server
   * Action does not only mark the named path: it invalidates the client Router
   * Cache and the action's response refreshes the CURRENT tree. So revalidating
   * /leads/:id still re-rendered the dashboard, unmounted the agenda row, and
   * took the "What's next?" dialog with it — the same "pops up and immediately
   * disappears" the comment below describes as already fixed. It was fixed one
   * level too high.
   */
  return activity;
}

export async function completeActivity(id: string, formData: FormData) {
  const activity = await finishActivity(id, String(formData.get("note") ?? ""));
  revalidateRecordPages(activity);
  revalidatePath(String(formData.get("revalidate") ?? "/activities"));
  revalidatePath("/activities");
  revalidatePath("/");
}

export type CompleteAssessment = {
  done: boolean;
  needsNextStep: boolean;
  leadId: string | null;
  leadName: string | null;
};

/**
 * The views a completed activity changes. Named once so the immediate path and
 * the deferred one cannot drift into refreshing different things.
 */
function revalidateActivityViews() {
  revalidatePath("/activities");
  revalidatePath("/");
  revalidatePath("/calendar");
}

/**
 * Refresh those views once the next-step dialog is finished with.
 *
 * completeActivityAssess deliberately does NOT revalidate when it reports
 * needsNextStep, because that unmounts the row holding the dialog open. The
 * client calls this when the dialog closes, however it closed.
 */
export async function refreshAfterNextStep(leadId?: string | null): Promise<void> {
  await requireUser();
  revalidateActivityViews();
  // The lead page was skipped along with the views while the dialog was open.
  if (leadId) revalidatePath(`/leads/${leadId}`);
}

export async function completeActivityAssess(
  id: string,
  note: string,
): Promise<CompleteAssessment> {
  const activity = await finishActivity(id, note);

  let needsNextStep = false;
  if (activity.lead && activity.lead.status === "open") {
    const remaining = await prisma.activity.count({
      where: { leadId: activity.leadId, status: "planned" },
    });
    needsNextStep = remaining === 0;
  }

  /*
   * REVALIDATE ONLY WHEN THE FLOW IS ACTUALLY OVER.
   *
   * These three calls used to run immediately after finishActivity, before
   * needsNextStep was even computed. When a next step IS needed, the caller
   * responds by opening the "What's next?" dialog — and the state holding that
   * dialog open lives in CompleteActivityButton, which sits INSIDE the agenda
   * row for the activity just completed.
   *
   * Revalidating "/" removes that row (it is no longer a planned activity), so
   * React unmounted the button, and the dialog went with it. Both happen in the
   * same transition as the setState that opened it, so the dialog painted and
   * vanished: "pops up and immediately disappears".
   *
   * When no next step is needed nothing opens, so refreshing here is right and
   * the row should go at once. When one IS needed the row has to outlive the
   * decision, and the client calls router.refresh() when the dialog closes —
   * whether it was completed or dismissed.
   */
  // Record pages go with the views, for the reason given in finishActivity:
  // revalidating ANY path refreshes the current tree, so these cannot run while
  // the dialog is open either.
  if (!needsNextStep) {
    revalidateActivityViews();
    revalidateRecordPages(activity);
  }

  return {
    done: true,
    needsNextStep,
    leadId: activity.leadId,
    leadName: activity.lead?.name ?? null,
  };
}

export async function rescheduleActivity(
  id: string,
  when: string,
): Promise<{ ok: boolean; error?: string }> {
  const { user, activity: existing } = await requireActivityAccess(id);
  let dueDate: Date;
  if (existing.type === FOLLOW_UP_TYPE) {
    const normalised = ensureFollowUpTime(when);
    dueDate = normalised ? new Date(`${normalised}:00+02:00`) : new Date(NaN);
    const problem = followUpDueDateError(dueDate, new Date());
    if (problem) return { ok: false, error: problem };
  } else {
    dueDate = new Date(when.includes("T") ? `${when}:00+02:00` : when);
    if (isNaN(dueDate.getTime())) return { ok: false, error: "Pick a valid date" };
  }

  const oldEnd = effectiveActivityEnd(existing.dueDate, existing.endDate);
  const duration = oldEnd.getTime() - existing.dueDate.getTime();
  const endDate = new Date(dueDate.getTime() + duration);
  const tenantId = existing.tenantId ?? await customerRecordTenantId({
    contactId: existing.contactId,
    leadId: existing.leadId,
  });

  const result = await prisma.$transaction(async (tx) => {
    await lockStaffSchedules(tx, tenantId ?? "global", [existing.assignedToId]);
    if (existing.availabilityBlock) {
      const conflict = await findStaffCommitmentConflict({
        userId: existing.assignedToId,
        start: dueDate,
        end: endDate,
        excludeActivityId: existing.id,
        db: tx,
      });
      if (conflict) return { error: commitmentConflictMessage(conflict) } as const;
    } else {
      const conflict = await findStaffAvailabilityConflict({
        userId: existing.assignedToId,
        start: dueDate,
        end: endDate,
        excludeActivityId: existing.id,
        db: tx,
      });
      if (conflict) return { error: availabilityConflictMessage(conflict) } as const;
    }
    const activity = await tx.activity.update({
      where: { id },
      data: { dueDate, endDate, reminderSentAt: null },
      include: { lead: true },
    });
    return { activity } as const;
  });
  if ("error" in result) return { ok: false, error: result.error };
  const activity = result.activity;

  await logAudit({
    action: "activity.rescheduled",
    summary: `Rescheduled ${activity.type} “${activity.summary}” to ${dueDate.toLocaleString(
      "en-ZA",
      {
        timeZone: "Africa/Johannesburg",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      },
    )}`,
    leadId: activity.leadId,
    contactId: activity.contactId ?? activity.lead?.contactId,
    user,
  });
  revalidatePath("/activities");
  revalidatePath("/");
  revalidatePath("/calendar");
  revalidateRecordPages(activity);
  return { ok: true };
}

export async function scheduleFollowUp(data: {
  leadId: string | null;
  contactId?: string | null;
  type: string;
  when: string;
  summary?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requirePermission("activities.manage");
  await assertLinks(user, data);
  const dueDate = new Date(
    data.when.includes("T") ? `${data.when}:00+02:00` : data.when,
  );
  if (isNaN(dueDate.getTime())) return { ok: false, error: "Pick a valid date" };
  const endDate = new Date(dueDate.getTime() + DEFAULT_ACTIVITY_DURATION_MS);
  const label =
    data.summary?.trim() ||
    ({
      call: "Follow-up call",
      email: "Follow-up email",
      whatsapp: "WhatsApp follow-up",
      meeting: "Meeting",
      test_drive: "Test Drive",
      todo: "Follow up",
    }[data.type]) ||
    "Follow up";
  const tenantId = await customerRecordTenantId({ contactId: data.contactId, leadId: data.leadId });
  const result = await prisma.$transaction(async (tx) => {
    await lockStaffSchedules(tx, tenantId ?? "global", [user.id]);
    const conflict = await findStaffAvailabilityConflict({
      userId: user.id,
      start: dueDate,
      end: endDate,
      db: tx,
    });
    if (conflict) return { conflict } as const;
    const activity = await tx.activity.create({
      data: {
        type: data.type,
        summary: label,
        dueDate,
        endDate,
        leadId: data.leadId,
        contactId: data.contactId ?? null,
        assignedToId: user.id,
        createdById: user.id,
        tenantId,
      },
    });
    return { activity } as const;
  });
  if ("conflict" in result && result.conflict) return { ok: false, error: availabilityConflictMessage(result.conflict) };
  const activity = result.activity;
  await logAudit({
    action: "activity.scheduled",
    summary: `Scheduled ${activity.type}: “${activity.summary}” (next step)`,
    leadId: data.leadId,
    contactId: data.contactId ?? null,
    user,
  });
  revalidatePath("/activities");
  revalidatePath("/");
  revalidatePath("/calendar");
  return { ok: true };
}

export async function cancelActivity(id: string, revalidate: string) {
  await requireActivityAccess(id);
  const activity = await prisma.activity.update({
    where: { id },
    data: { status: "canceled" },
    include: { lead: true },
  });
  revalidatePath(revalidate);
  revalidatePath("/activities");
  revalidatePath("/");
  revalidatePath("/calendar");
  revalidateRecordPages(activity);
}

export async function updateActivity(
  id: string,
  formData: FormData,
): Promise<{ error?: string; success?: string }> {
  const { user, activity: existing } = await requireActivityAccess(id);
  const summary = String(formData.get("summary") ?? "").trim();
  if (!summary) return { error: "What needs to happen is required." };
  const type = str(formData, "type") ?? "todo";
  const rawDue = str(formData, "dueDate");
  const rawEnd = str(formData, "endDate");

  let dueDate = existing.dueDate;
  if (rawDue) {
    if (type === FOLLOW_UP_TYPE) {
      dueDate = new Date(`${ensureFollowUpTime(rawDue)}:00+02:00`);
      const problem = followUpDueDateError(dueDate, new Date());
      if (problem) return { error: problem };
    } else {
      dueDate = rawDue.endsWith("T00:00")
        ? new Date(rawDue.slice(0, 10))
        : rawDue.includes("T")
          ? new Date(`${rawDue}:00+02:00`)
          : new Date(rawDue);
    }
  }
  if (Number.isNaN(dueDate.getTime())) return { error: "Pick a valid start date and time." };

  const previousEnd = effectiveActivityEnd(existing.dueDate, existing.endDate);
  const previousDuration = previousEnd.getTime() - existing.dueDate.getTime();
  const endDate = rawEnd
    ? new Date(rawEnd.includes("T") ? `${rawEnd}:00+02:00` : rawEnd)
    : new Date(dueDate.getTime() + previousDuration);
  if (Number.isNaN(endDate.getTime()) || endDate <= dueDate) {
    return { error: "End time must be after the start time." };
  }

  const assignedToId = (await resolveActivityAssignee(formData))?.id ?? user.id;
  const tenantId = existing.tenantId ?? await customerRecordTenantId({
    contactId: existing.contactId,
    leadId: existing.leadId,
  });

  const result = await prisma.$transaction(async (tx) => {
    await lockStaffSchedules(tx, tenantId ?? "global", [existing.assignedToId, assignedToId]);
    if (existing.availabilityBlock) {
      const conflict = await findStaffCommitmentConflict({
        userId: assignedToId,
        start: dueDate,
        end: endDate,
        excludeActivityId: existing.id,
        db: tx,
      });
      if (conflict) return { error: commitmentConflictMessage(conflict) } as const;
    } else {
      const conflict = await findStaffAvailabilityConflict({
        userId: assignedToId,
        start: dueDate,
        end: endDate,
        excludeActivityId: existing.id,
        db: tx,
      });
      if (conflict) return { error: availabilityConflictMessage(conflict) } as const;
    }
    const activity = await tx.activity.update({
      where: { id },
      data: {
        type,
        category: formData.get("workshop") === "on" ? "workshop" : null,
        summary,
        location: str(formData, "location"),
        assignedToId,
        dueDate,
        endDate,
        reminderSentAt: null,
      },
    });
    return { activity } as const;
  });
  if ("error" in result) return { error: result.error };
  const activity = result.activity;

  await logAudit({
    action: "activity.updated",
    summary: `Updated activity “${summary}”`,
    leadId: activity.leadId,
    contactId: activity.contactId,
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/activities"));
  revalidatePath("/activities");
  revalidatePath("/calendar");
  revalidatePath("/");
  return { success: "Activity updated" };
}

