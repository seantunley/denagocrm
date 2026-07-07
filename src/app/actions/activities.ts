"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export async function scheduleActivity(formData: FormData) {
  const user = await requireUser();
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
  const user = await requireUser();
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

export async function cancelActivity(id: string, revalidate: string) {
  await requireUser();
  await prisma.activity.update({
    where: { id },
    data: { status: "canceled" },
  });
  revalidatePath(revalidate);
  revalidatePath("/activities");
  revalidatePath("/");
}
