"use server";

import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { requireJobCardReadAccess } from "@/lib/permissions";
import { canOpenRecord, tellAboutNote } from "@/lib/collaboration";
import { isWatchable, recordHref } from "@/lib/collaborationRules";

/** The @ list: this workspace's staff, names only. */
export async function listMentionableStaff(): Promise<{ id: string; name: string }[]> {
  await requireUser();
  return (await listActingTenantStaff()).map((person) => ({ id: person.id, name: person.name }));
}

/** Watch or stop watching a lead, customer or job card you can open. */
export async function toggleRecordWatch(recordType: string, recordId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireUser();
    if (!isWatchable(recordType) || !recordId) refuse("That can't be watched.");
    if (!(await canOpenRecord(user, { type: recordType, id: recordId }))) refuse("You can't open that record.");
    const tenantId = await actingTenantId();
    const existing = await basePrisma.recordWatch.findUnique({
      where: { tenantId_userId_recordType_recordId: { tenantId, userId: user.id, recordType, recordId } },
      select: { userId: true },
    });
    if (existing) await basePrisma.recordWatch.deleteMany({ where: { tenantId, userId: user.id, recordType, recordId } });
    else await basePrisma.recordWatch.create({ data: { tenantId, userId: user.id, recordType, recordId } });
    revalidatePath(recordHref(recordType, recordId));
    return { success: existing ? "Stopped watching" : "Watching — you'll hear about notes, changes and replies" };
  });
}

/** Mark your notifications read (all of them, or the ones named). */
export async function markNotificationsRead(ids?: string[]): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireUser();
    const tenantId = await actingTenantId();
    await basePrisma.staffNotification.updateMany({
      where: { tenantId, userId: user.id, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
    revalidatePath("/notifications");
    revalidatePath("/", "layout");
  });
}

/** A staff-only note on a job card. Anyone who may open the job card can write one and @mention the team. */
export async function addJobCardNote(jobCardId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireJobCardReadAccess(jobCardId);
    const body = String(formData.get("body") ?? "").trim();
    if (!body) refuse("Write something before saving the note.");
    if (body.length > 5000) refuse("Keep a note under 5,000 characters.");
    const tenantId = await actingTenantId();
    const job = await basePrisma.jobCard.findFirst({ where: { id: jobCardId, tenantId }, select: { number: true, contactId: true } });
    if (!job) refuse("That job card is no longer there — refresh the page.");
    const staff = await listActingTenantStaff();
    const picked = formData.getAll("mentions").map(String).flatMap((value) => value.split(",")).filter(Boolean);
    const { mentionedIds } = await import("@/lib/collaborationRules");
    await basePrisma.jobCardNote.create({
      data: { tenantId, jobCardId, authorId: user.id, body, mentions: mentionedIds(body, picked, staff) },
    });
    await logAudit({ action: "jobcard.note_added", summary: `Added a team note to job card #${job.number}`, contactId: job.contactId, user });
    const success = await tellAboutNote({
      tenantId, actorId: user.id, text: body, picked, staff,
      mentionOn: { type: "jobcard", id: jobCardId },
      watchRefs: [{ type: "jobcard", id: jobCardId }],
    });
    revalidatePath(`/jobcards/${jobCardId}`);
    return { success };
  });
}
