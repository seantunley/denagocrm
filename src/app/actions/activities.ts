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
import { logAudit } from "@/lib/audit";
import { reserveSlot } from "@/lib/bookingSlots";
import { ensureTimelinePin } from "@/lib/timelinePins";
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

export async function scheduleActivity(formData: FormData) {
  const user = await requirePermission("activities.manage");
  const summary = String(formData.get("summary") ?? "").trim();
  if (!summary) return;
  const leadId = str(formData, "leadId");
  const contactId = str(formData, "contactId");
  await assertLinks(user, { leadId, contactId });

  const rawDue = str(formData, "dueDate");
  const type = str(formData, "type") ?? "todo";
  const note = str(formData, "note");
  const location = str(formData, "location");
  const assignedToId = str(formData, "assignedToId") ?? user.id;
  const workshop = formData.get("workshop") === "on";

  let activity;
  if (workshop) {
    if (!rawDue || !rawDue.includes("T")) {
      throw new Error("Pick a configured workshop date and time");
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
        userId: user.id,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "SLOT_TAKEN") {
        throw new Error(
          "That workshop time has just filled up. Pick another available slot.",
        );
      }
      if (code === "SLOT_INVALID") {
        throw new Error(
          "That workshop slot is no longer available. Pick a future configured date and time.",
        );
      }
      throw error;
    }
  } else {
    let dueDate: Date;
    if (type === FOLLOW_UP_TYPE) {
      // A follow-up MUST have a note and a real, future time — the latter so the
      // existing hour-before reminder push (which skips midnight) fires.
      dueDate = rawDue
        ? new Date(`${ensureFollowUpTime(rawDue)}:00+02:00`)
        : new Date(NaN);
      const problem = followUpValidationError({ note, dueDate }, new Date());
      if (problem) throw new Error(problem);
    } else {
      dueDate = rawDue
        ? rawDue.includes("T")
          ? new Date(`${rawDue}:00+02:00`)
          : new Date(rawDue)
        : new Date();
    }
    activity = await prisma.activity.create({
      data: {
        type,
        category: null,
        summary,
        note,
        dueDate,
        location,
        leadId,
        contactId,
        assignedToId,
        createdById: user.id,
        // Activity carries composite tenant foreign keys to Lead and Contact — the
        // customer record owns the row, and stamping anything else refuses the write.
        tenantId: await customerRecordTenantId({ contactId, leadId }),
      },
    });
  }

  // Auto-pin a new follow-up to the top of the timeline. It stays pinned until
  // manually unpinned (we never auto-unpin, even on completion).
  if (activity.type === FOLLOW_UP_TYPE) {
    await ensureTimelinePin("activity", activity.id, user.id);
  }

  const assignee =
    activity.assignedToId === user.id
      ? user
      : await prisma.user.findUnique({ where: { id: activity.assignedToId } });
  await logAudit({
    action: "activity.scheduled",
    summary: `Scheduled ${activity.type}: “${summary}”${activity.location ? ` at ${activity.location}` : ""} — assigned to ${assignee?.name ?? user.name}`,
    leadId,
    contactId,
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/activities"));
  revalidatePath("/activities");
  revalidatePath("/");
}

async function finishActivity(id: string, note: string) {
  const { user } = await requireActivityAccess(id);
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
  revalidateRecordPages(activity);
  return activity;
}

export async function completeActivity(id: string, formData: FormData) {
  await finishActivity(id, String(formData.get("note") ?? ""));
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
export async function refreshAfterNextStep(): Promise<void> {
  await requireUser();
  revalidateActivityViews();
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
  if (!needsNextStep) revalidateActivityViews();

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
  // Preserve the follow-up "real future time" invariant that updateActivity
  // enforces: the hour-before reminder push skips midnight, so a follow-up
  // rescheduled to a past/midnight time would silently miss its nudge.
  let dueDate: Date;
  if (existing.type === FOLLOW_UP_TYPE) {
    const normalised = ensureFollowUpTime(when);
    dueDate = normalised ? new Date(`${normalised}:00+02:00`) : new Date(NaN);
    const problem = followUpDueDateError(dueDate, new Date());
    if (problem) return { ok: false, error: problem };
  } else {
    dueDate = new Date(when.includes("T") ? `${when}:00+02:00` : when);
    if (isNaN(dueDate.getTime())) {
      return { ok: false, error: "Pick a valid date" };
    }
  }
  const activity = await prisma.activity.update({
    where: { id },
    data: { dueDate, reminderSentAt: null },
    include: { lead: true },
  });
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
  if (isNaN(dueDate.getTime())) {
    return { ok: false, error: "Pick a valid date" };
  }
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
  const activity = await prisma.activity.create({
    data: {
      type: data.type,
      summary: label,
      dueDate,
      leadId: data.leadId,
      contactId: data.contactId ?? null,
      assignedToId: user.id,
      createdById: user.id,
      tenantId: await customerRecordTenantId({ contactId: data.contactId, leadId: data.leadId }),
    },
  });
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
  revalidateRecordPages(activity);
}

export async function updateActivity(id: string, formData: FormData) {
  const { user } = await requireActivityAccess(id);
  const summary = String(formData.get("summary") ?? "").trim();
  if (!summary) return;
  const type = str(formData, "type") ?? "todo";
  const rawDue = str(formData, "dueDate");

  // Editing an existing follow-up must preserve its "real future time"
  // invariant: the hour-before reminder push skips midnight, so a follow-up
  // edited to 00:00 or a past time would silently miss its nudge. The edit form
  // neither submits nor persists a note, so we enforce ONLY the due-date rule
  // here — we never newly require a note nor touch the existing one.
  let duePatch = {};
  if (rawDue) {
    let dueDate: Date;
    if (type === FOLLOW_UP_TYPE) {
      dueDate = new Date(`${ensureFollowUpTime(rawDue)}:00+02:00`);
      const problem = followUpDueDateError(dueDate, new Date());
      if (problem) throw new Error(problem);
    } else {
      dueDate = rawDue.endsWith("T00:00")
        ? new Date(rawDue.slice(0, 10))
        : rawDue.includes("T")
          ? new Date(`${rawDue}:00+02:00`)
          : new Date(rawDue);
    }
    duePatch = { dueDate, reminderSentAt: null };
  }

  const activity = await prisma.activity.update({
    where: { id },
    data: {
      type,
      category: formData.get("workshop") === "on" ? "workshop" : null,
      summary,
      location: str(formData, "location"),
      assignedToId: str(formData, "assignedToId") ?? user.id,
      ...duePatch,
    },
  });
  await logAudit({
    action: "activity.updated",
    summary: `Updated activity “${summary}”`,
    leadId: activity.leadId,
    contactId: activity.contactId,
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/activities"));
  revalidatePath("/activities");
  revalidatePath("/");
}
