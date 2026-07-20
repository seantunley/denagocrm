"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrmOrWorkshop } from "@/lib/auth";
import { canAccessContact, canAccessLead, requirePermission, requireAnyPermission } from "@/lib/permissions";
import {
  removeTimelinePin,
  toggleTimelinePin,
} from "@/lib/timelinePins";

async function assertCommunicationAccess(
  user: Awaited<ReturnType<typeof requireCrmOrWorkshop>>,
  communication: { contactId: string | null; leadId: string | null },
) {
  if (user.role === "owner") return;
  const allowed =
    (!communication.contactId && !communication.leadId) ||
    (communication.contactId
      ? await canAccessContact(user, communication.contactId)
      : false) ||
    (communication.leadId
      ? await canAccessLead(user, communication.leadId)
      : false);
  if (!allowed) throw new Error("Communication access denied");
}

export async function addCommunication(formData: FormData) {
  const user = await requireCrmOrWorkshop();
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const body = String(formData.get("body") ?? "").trim();
  const file = formData.get("image");
  const hasFile =
    file &&
    typeof file === "object" &&
    (file as File).size > 0 &&
    (file as File).size <= 4 * 1024 * 1024;
  if (!body && !hasFile) return;

  let attachmentUrl: string | null = null;
  if (hasFile && (file as File).type.startsWith("image/")) {
    const { saveFile } = await import("@/lib/storage");
    const f = file as File;
    attachmentUrl = await saveFile(
      Buffer.from(await f.arrayBuffer()),
      f.name || "note.png",
      f.type,
    );
  }

  const occurredAtRaw = str("occurredAt");
  const communication = await prisma.communication.create({
    data: {
      type: str("type") ?? "note",
      direction: str("direction"),
      subject: str("subject"),
      body: body || "🖼 Image",
      attachmentUrl,
      attachmentType: attachmentUrl ? "image" : null,
      occurredAt: occurredAtRaw ? new Date(occurredAtRaw) : new Date(),
      contactId: str("contactId"),
      leadId: str("leadId"),
      userId: user.id,
    },
  });

  if (formData.get("pin") === "on") {
    await toggleTimelinePin("communication", communication.id, user.id);
  }

  revalidatePath(String(formData.get("revalidate") ?? "/"));
}

export async function toggleCommunicationPin(id: string, path: string) {
  const user = await requireCrmOrWorkshop();
  const communication = await prisma.communication.findUniqueOrThrow({
    where: { id },
    select: {
      contactId: true,
      leadId: true,
      type: true,
      body: true,
    },
  });
  await assertCommunicationAccess(user, communication);

  const result = await toggleTimelinePin("communication", id, user.id);
  const { logAudit } = await import("@/lib/audit");
  await logAudit({
    action: result.pinned ? "communication.pinned" : "communication.unpinned",
    summary: `${result.pinned ? "Pinned" : "Unpinned"} ${communication.type} entry: “${communication.body.slice(0, 80)}${communication.body.length > 80 ? "…" : ""}”`,
    contactId: communication.contactId,
    leadId: communication.leadId,
    user,
  });
  revalidatePath(path);
}

/**
 * Marks a social-inbox thread as read — stamps readAt on every unopened inbound
 * message in the conversation. Fired when the thread is opened in the inbox, so
 * the sidebar badge and the thread's pill flip from "Unread" to "Read". Idempotent.
 */
export async function markThreadRead(
  contactId: string | null,
  leadId: string | null,
  channel: string,
) {
  const user = await requireAnyPermission("inbox.view", "inbox.reply");
  if (!contactId && !leadId) return;
  if (contactId && !(await canAccessContact(user, contactId)))
    throw new Error("Customer access denied");
  if (leadId && !(await canAccessLead(user, leadId)))
    throw new Error("Lead access denied");
  await prisma.communication.updateMany({
    where: {
      type: channel,
      direction: "inbound",
      readAt: null,
      ...(contactId ? { contactId } : { leadId }),
    },
    data: { readAt: new Date() },
  });
  revalidatePath("/inbox");
  revalidatePath("/messages");
}

/**
 * Archive (or restore) a whole inbox thread — every message on this channel for
 * the contact/lead. Archiving hides it from the inbox without deleting anything;
 * an "Archived" view lists them and can restore. Test conversations that can't be
 * deleted live here.
 */
export async function setThreadArchived(
  contactId: string | null,
  leadId: string | null,
  channel: string,
  archived: boolean,
) {
  const user = await requirePermission("inbox.reply");
  if (!contactId && !leadId) return;
  if (contactId && !(await canAccessContact(user, contactId)))
    throw new Error("Customer access denied");
  if (leadId && !(await canAccessLead(user, leadId)))
    throw new Error("Lead access denied");
  await prisma.communication.updateMany({
    where: {
      type: channel,
      ...(contactId ? { contactId } : { leadId }),
    },
    data: { archivedAt: archived ? new Date() : null },
  });
  revalidatePath("/inbox");
  revalidatePath("/messages");
}

export async function deleteCommunication(
  id: string,
  path: string,
  formData: FormData,
) {
  const user = await requireCrmOrWorkshop();
  const reason =
    String(formData.get("reason") ?? "").trim() || "No reason given";
  const communication = await prisma.communication.findUniqueOrThrow({
    where: { id },
    select: { contactId: true, leadId: true },
  });
  await assertCommunicationAccess(user, communication);
  await removeTimelinePin("communication", id);
  const comm = await prisma.communication.delete({ where: { id } });
  const { logAudit } = await import("@/lib/audit");
  await logAudit({
    action: "communication.deleted",
    summary: `Deleted ${comm.type} entry (“${comm.body.slice(0, 80)}${comm.body.length > 80 ? "…" : ""}”) — ${reason}`,
    contactId: comm.contactId,
    leadId: comm.leadId,
    user,
  });
  revalidatePath(path);
}
