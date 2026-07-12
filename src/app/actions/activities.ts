"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrmOrWorkshop } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function scheduleActivity(formData: FormData) {
  const user = await requireCrmOrWorkshop();
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const summary = String(formData.get("summary") ?? "").trim();
  if (!summary) return;

  await prisma.activity.create({
    data: {
      type: str("type") ?? "todo",
      category: formData.get("workshop") === "on" ? "workshop" : null,
      summary,
      note: str("note"),
      dueDate: (() => {
        const raw = str("dueDate");
        if (!raw) return new Date();
        // datetime-local has no zone — treat it as South African time
        return raw.includes("T") ? new Date(`${raw}:00+02:00`) : new Date(raw);
      })(),
      location: str("location"),
      leadId: str("leadId"),
      contactId: str("contactId"),
      assignedToId: str("assignedToId") ?? user.id,
      createdById: user.id,
    },
  });
  const assignee = str("assignedToId")
    ? await prisma.user.findUnique({ where: { id: String(str("assignedToId")) } })
    : user;
  await logAudit({
    action: "activity.scheduled",
    summary: `Scheduled ${str("type") ?? "to-do"}: “${summary}”${
      str("location") ? ` at ${str("location")}` : ""
    } — assigned to ${assignee?.name ?? user.name}`,
    leadId: str("leadId"),
    contactId: str("contactId"),
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/activities"));
  revalidatePath("/activities");
  revalidatePath("/");
}

/** Marks done; an optional note is logged to the communications timeline (Odoo-chatter style). */
export async function completeActivity(id: string, formData: FormData) {
  const user = await requireCrmOrWorkshop();
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
  const note = String(formData.get("note") ?? "").trim();
  if (note) {
    await prisma.communication.create({
      data: {
        type: activity.type === "todo" ? "note" : activity.type,
        direction: "outbound",
        subject: `Activity done: ${activity.summary}`,
        body: note,
        leadId: activity.leadId,
        contactId: activity.contactId,
        userId: user.id,
      },
    });
  }
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
 * Complete an activity AND report whether its lead is now a dead end
 * (open lead with no other planned activity) — the client then forces a
 * "what's next?" decision so nothing stalls silently on the board.
 */
export async function completeActivityAssess(
  id: string,
  note: string
): Promise<CompleteAssessment> {
  const user = await requireCrmOrWorkshop();
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
      },
    });
  }
  revalidatePath("/activities");
  revalidatePath("/");
  revalidatePath("/calendar");

  let needsNextStep = false;
  if (activity.lead && activity.lead.status === "open") {
    const remaining = await prisma.activity.count({
      where: { leadId: activity.leadId, status: "planned" },
    });
    needsNextStep = remaining === 0;
  }
  return {
    done: true,
    needsNextStep,
    leadId: activity.leadId,
    leadName: activity.lead?.name ?? null,
  };
}

/** Move a planned activity to a new date/time (didn't happen — rebook it). */
export async function rescheduleActivity(
  id: string,
  when: string
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCrmOrWorkshop();
  const dueDate = new Date(when.includes("T") ? `${when}:00+02:00` : when);
  if (isNaN(dueDate.getTime())) return { ok: false, error: "Pick a valid date" };
  const activity = await prisma.activity.update({
    where: { id },
    data: { dueDate, reminderSentAt: null },
    include: { lead: true },
  });
  await logAudit({
    action: "activity.rescheduled",
    summary: `Rescheduled ${activity.type} “${activity.summary}” to ${dueDate.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`,
    leadId: activity.leadId,
    contactId: activity.contactId ?? activity.lead?.contactId,
    user,
  });
  revalidatePath("/activities");
  revalidatePath("/");
  revalidatePath("/calendar");
  return { ok: true };
}

/** One-tap follow-up creation from the next-step dialog. */
export async function scheduleFollowUp(data: {
  leadId: string | null;
  contactId?: string | null;
  type: string;
  when: string; // datetime-local, SA time
  summary?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCrmOrWorkshop();
  const dueDate = new Date(data.when.includes("T") ? `${data.when}:00+02:00` : data.when);
  if (isNaN(dueDate.getTime())) return { ok: false, error: "Pick a valid date" };
  const label =
    data.summary?.trim() ||
    { call: "Follow-up call", email: "Follow-up email", whatsapp: "WhatsApp follow-up", meeting: "Meeting", test_drive: "Test Drive", todo: "Follow up" }[
      data.type
    ] ||
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
  await requireCrmOrWorkshop();
  await prisma.activity.update({
    where: { id },
    data: { status: "canceled" },
  });
  revalidatePath(revalidate);
  revalidatePath("/activities");
  revalidatePath("/");
}

/** Edits a planned activity — same fields as scheduling, audit-logged. */
export async function updateActivity(id: string, formData: FormData) {
  const user = await requireCrmOrWorkshop();
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const summary = String(formData.get("summary") ?? "").trim();
  if (!summary) return;
  const rawDue = str("dueDate");
  const activity = await prisma.activity.update({
    where: { id },
    data: {
      type: str("type") ?? "todo",
      category: formData.get("workshop") === "on" ? "workshop" : null,
      summary,
      location: str("location"),
      assignedToId: str("assignedToId") ?? user.id,
      ...(rawDue
        ? {
            dueDate: rawDue.endsWith("T00:00")
              ? new Date(rawDue.slice(0, 10)) // date-only stays date-only
              : rawDue.includes("T")
              ? new Date(`${rawDue}:00+02:00`)
              : new Date(rawDue),
            reminderSentAt: null, // re-arm the hour-before reminder
          }
        : {}),
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
