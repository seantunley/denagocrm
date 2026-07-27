"use server";

import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma, basePrisma } from "@/lib/db";
import { writeTenantId, withTenantWrite } from "@/lib/tenantWrite";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { logAudit } from "@/lib/audit";
import {
  requirePermission,
  requireCaseAccess,
  requireContactAccess,
} from "@/lib/permissions";
import {
  STATUS_VALUES,
  PRIORITY_VALUES,
  TICKET_TYPES,
  statusMeta,
} from "@/lib/helpdesk-constants";

function str(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || randomUUID().slice(0, 8);
}

async function loadCase(caseId: string) {
  return prisma.customerCase.findUnique({
    where: { id: caseId },
    select: { id: true, number: true, status: true, contactId: true, priority: true, type: true, mailboxId: true, assignedToId: true, firstResponseAt: true },
  });
}

/** Insert a PortalNotification so the customer sees the update in their portal. */
async function notifyCustomer(contactId: string, title: string, body: string, href: string) {
  // Founding tenant when enforcement is off, so this never lands tenantless.
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  await basePrisma.$executeRaw`
    INSERT INTO "PortalNotification" ("id","contactId","title","body","href","kind","tenantId")
    VALUES (${randomUUID()}, ${contactId}, ${title}, ${body}, ${href}, 'case', ${tenantId})`;
}

/** Append a system "event" line item to the ticket timeline. */
async function logEvent(caseId: string, userId: string, body: string, meta: Prisma.InputJsonObject) {
  await prisma.customerCaseMessage.create({
    data: { caseId, userId, direction: "staff", type: "event", body, meta, tenantId: writeTenantId() ?? DEFAULT_TENANT_ID },
  });
}

// ── Create ──────────────────────────────────────────────────────────────────
export async function createTicket(formData: FormData): Promise<void> {
  const contactId = str(formData, "contactId");
  const user = await requireContactAccess(contactId, "cases.create");
  const subject = str(formData, "subject");
  const description = str(formData, "description");
  if (subject.length < 3 || description.length < 5) {
    throw new Error("A ticket needs a subject and a short description.");
  }
  const type = TICKET_TYPES.includes(str(formData, "type") as (typeof TICKET_TYPES)[number]) ? str(formData, "type") : "support";
  const priority = PRIORITY_VALUES.includes(str(formData, "priority")) ? str(formData, "priority") : "normal";
  const mailboxId = str(formData, "mailboxId") || null;
  const vehicleId = str(formData, "vehicleId") || null;
  const assignToMe = formData.get("assignToMe") === "on";

  // Atomic: the case + its opening message in ONE transaction, tenant-stamped.
  const created = await withTenantWrite(async (tx, tenantId) => {
    const c = await tx.customerCase.create({
      data: {
        subject,
        description,
        type,
        priority,
        status: "open",
        source: "staff",
        contactId,
        vehicleId,
        mailboxId,
        assignedToId: assignToMe ? user.id : null,
        lastReplyBy: "staff",
        lastReplyAt: new Date(),
        tenantId,
      },
      select: { id: true, number: true },
    });
    await tx.customerCaseMessage.create({
      data: { caseId: c.id, userId: user.id, direction: "staff", type: "staff", body: description, tenantId },
    });
    return c;
  });

  await logAudit({
    action: "case.created",
    summary: `Created ticket C-${created.number} for a customer`,
    contactId,
    user,
    entityType: "CustomerCase",
    entityId: created.id,
  });
  revalidatePath("/cases");
  redirect(`/cases/${created.id}`);
}

// ── Public reply ──────────────────────────────────────────────────────────────
export async function replyToTicket(caseId: string, formData: FormData): Promise<void> {
  const user = await requireCaseAccess(caseId, "cases.reply");
  const body = str(formData, "body");
  if (body.length < 2) throw new Error("Write a reply before sending.");
  const requested = str(formData, "status");
  const nextStatus = STATUS_VALUES.includes(requested) ? requested : "waiting_customer";

  const item = await loadCase(caseId);
  if (!item) redirect("/cases");
  const now = new Date();

  // Atomic: append the reply + advance the case in ONE transaction (the case was
  // authorised by requireCaseAccess above). Uses the proven bypass transaction path
  // rather than a scoped array transaction, whose GUC interaction is the fragile area.
  await withTenantWrite(async (tx, tenantId) => {
    await tx.customerCaseMessage.create({
      data: { caseId, userId: user.id, direction: "staff", type: "staff", body, tenantId },
    });
    await tx.customerCase.update({
      where: { id: caseId },
      data: {
        status: nextStatus,
        lastReplyBy: "staff",
        lastReplyAt: now,
        firstResponseAt: item.firstResponseAt ?? now,
        resolvedAt: nextStatus === "resolved" ? now : undefined,
        closedAt: nextStatus === "closed" ? now : undefined,
      },
    });
  });

  await notifyCustomer(
    item.contactId,
    `Update on ticket C-${item.number}`,
    body.slice(0, 180),
    `/portal/support/${caseId}`,
  );
  await logAudit({
    action: "case.staff_reply",
    summary: `Replied to ticket C-${item.number}`,
    contactId: item.contactId,
    user,
    entityType: "CustomerCase",
    entityId: caseId,
  });
  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  revalidatePath(`/portal/support/${caseId}`);
}

// ── Internal note (never shown to the customer) ───────────────────────────────
export async function addNote(caseId: string, formData: FormData): Promise<void> {
  const user = await requireCaseAccess(caseId, "cases.reply");
  const body = str(formData, "body");
  if (body.length < 1) throw new Error("Write a note before saving.");
  await prisma.customerCaseMessage.create({
    data: { caseId, userId: user.id, direction: "staff", type: "note", body, tenantId: writeTenantId() ?? DEFAULT_TENANT_ID },
  });
  await logAudit({ action: "case.note_added", summary: "Added an internal note", user, entityType: "CustomerCase", entityId: caseId });
  revalidatePath(`/cases/${caseId}`);
}

// ── Assignment ────────────────────────────────────────────────────────────────
export async function assignTicket(caseId: string, formData: FormData): Promise<void> {
  const user = await requireCaseAccess(caseId, "cases.assign");
  const raw = str(formData, "assigneeId");
  const assigneeId = raw === "" ? null : raw;
  const assignee = assigneeId ? await basePrisma.user.findUnique({ where: { id: assigneeId }, select: { name: true } }) : null;
  if (assigneeId && !assignee) throw new Error("That agent no longer exists.");

  await prisma.customerCase.update({ where: { id: caseId }, data: { assignedToId: assigneeId, updatedAt: new Date() } });
  await logEvent(caseId, user.id, assigneeId ? `Assigned to ${assignee?.name}` : "Unassigned", { event: "assigned", to: assigneeId });
  await logAudit({ action: "case.assigned", summary: assigneeId ? `Assigned ticket to ${assignee?.name}` : "Unassigned ticket", user, entityType: "CustomerCase", entityId: caseId });
  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
}

// ── Status ────────────────────────────────────────────────────────────────────
export async function setTicketStatus(caseId: string, formData: FormData): Promise<void> {
  const user = await requireCaseAccess(caseId, "cases.manage");
  const status = str(formData, "status");
  if (!STATUS_VALUES.includes(status)) throw new Error("Invalid ticket status.");
  const item = await loadCase(caseId);
  if (!item) redirect("/cases");
  if (item.status === status) return;
  const now = new Date();
  await prisma.customerCase.update({
    where: { id: caseId },
    data: {
      status,
      resolvedAt: status === "resolved" ? now : undefined,
      closedAt: status === "closed" ? now : undefined,
    },
  });
  await logEvent(caseId, user.id, `Status changed to ${statusMeta(status).label}`, { event: "status", from: item.status, to: status });
  await notifyCustomer(item.contactId, `Ticket C-${item.number} updated`, `Your ticket is now ${statusMeta(status).label}.`, `/portal/support/${caseId}`);
  await logAudit({ action: "case.status_changed", summary: `Ticket C-${item.number}: ${item.status} → ${status}`, contactId: item.contactId, user, entityType: "CustomerCase", entityId: caseId, before: { status: item.status }, after: { status } });
  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  revalidatePath(`/portal/support/${caseId}`);
}

// ── Priority / type / mailbox ─────────────────────────────────────────────────
export async function setTicketPriority(caseId: string, formData: FormData): Promise<void> {
  const user = await requireCaseAccess(caseId, "cases.manage");
  const priority = str(formData, "priority");
  if (!PRIORITY_VALUES.includes(priority)) throw new Error("Invalid priority.");
  await prisma.customerCase.update({ where: { id: caseId }, data: { priority } });
  await logEvent(caseId, user.id, `Priority set to ${priority}`, { event: "priority", to: priority });
  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
}

export async function setTicketMailbox(caseId: string, formData: FormData): Promise<void> {
  const user = await requireCaseAccess(caseId, "cases.manage");
  const mailboxId = str(formData, "mailboxId") || null;
  const mailbox = mailboxId ? await basePrisma.supportMailbox.findUnique({ where: { id: mailboxId }, select: { name: true } }) : null;
  await prisma.customerCase.update({ where: { id: caseId }, data: { mailboxId } });
  await logEvent(caseId, user.id, mailbox ? `Moved to ${mailbox.name}` : "Removed from mailbox", { event: "mailbox", to: mailboxId });
  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
}

// ── Tags (create-on-use) ──────────────────────────────────────────────────────
export async function addTicketTag(caseId: string, formData: FormData): Promise<void> {
  const user = await requireCaseAccess(caseId, "cases.manage");
  const name = str(formData, "name");
  if (name.length < 1) return;
  const slug = slugify(name);
  // slug is unique PER TENANT now (@@unique([tenantId, slug])). Stamp the owning
  // tenant explicitly so this is correct with enforcement OFF too (the scoped
  // guard is dormant then and would leave tenantId NULL, violating NOT NULL).
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  const tag = await prisma.supportTag.upsert({
    where: { tenantId_slug: { tenantId, slug } },
    update: {},
    create: { name, slug, tenantId },
  });
  await prisma.customerCaseTag.upsert({
    where: { caseId_tagId: { caseId, tagId: tag.id } },
    update: {},
    create: { caseId, tagId: tag.id, tenantId },
  });
  await logEvent(caseId, user.id, `Tagged "${tag.name}"`, { event: "tag_added", tag: tag.name });
  revalidatePath(`/cases/${caseId}`);
}

export async function removeTicketTag(caseId: string, tagId: string): Promise<void> {
  const user = await requireCaseAccess(caseId, "cases.manage");
  await prisma.customerCaseTag.deleteMany({ where: { caseId, tagId } });
  await logEvent(caseId, user.id, "Removed a tag", { event: "tag_removed", tagId });
  revalidatePath(`/cases/${caseId}`);
}

// ── Settings: mailboxes ───────────────────────────────────────────────────────
export async function saveMailbox(formData: FormData): Promise<void> {
  const user = await requirePermission("cases.manage");
  const id = str(formData, "id");
  const name = str(formData, "name");
  if (name.length < 2) throw new Error("Give the mailbox a name.");
  const color = str(formData, "color") || "#ea580c";
  const signature = str(formData, "signature") || null;
  const email = str(formData, "email").toLowerCase() || null;
  const autoReplyEnabled = formData.get("autoReplyEnabled") === "on";
  const autoReplyBody = str(formData, "autoReplyBody") || null;
  const active = formData.get("active") !== "off";
  // Check cross-tenant for email uniqueness — the inbound address routes mail globally.
  if (email) {
    const clash = await basePrisma.supportMailbox.findFirst({
      where: { email: { equals: email, mode: "insensitive" }, ...(id ? { id: { not: id } } : {}) },
      select: { name: true },
    });
    if (clash) throw new Error(`That inbox address is already used by the "${clash.name}" mailbox.`);
  }
  const data = { name, color, signature, email, autoReplyEnabled, autoReplyBody, active };
  if (id) {
    await prisma.supportMailbox.update({ where: { id }, data });
  } else {
    // Stamp the owning tenant explicitly — tenantId is NOT NULL and the scoped
    // guard is dormant with enforcement off. slug is unique per tenant.
    const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
    await prisma.supportMailbox.create({ data: { ...data, slug: slugify(name), tenantId } });
  }
  await logAudit({ action: "helpdesk.mailbox_saved", summary: `Saved mailbox ${name}`, user });
  revalidatePath("/settings/helpdesk");
}

// ── Settings: canned replies ──────────────────────────────────────────────────
export async function saveCannedReply(formData: FormData): Promise<void> {
  const user = await requirePermission("cases.manage");
  const id = str(formData, "id");
  const title = str(formData, "title");
  const body = str(formData, "body");
  const mailboxId = str(formData, "mailboxId") || null;
  if (title.length < 2 || body.length < 2) throw new Error("A saved reply needs a title and body.");
  if (id) {
    await prisma.cannedReply.update({ where: { id }, data: { title, body, mailboxId } });
  } else {
    await prisma.cannedReply.create({ data: { title, body, mailboxId, createdById: user.id, tenantId: writeTenantId() ?? DEFAULT_TENANT_ID } });
  }
  await logAudit({ action: "helpdesk.canned_saved", summary: `Saved reply ${title}`, user });
  revalidatePath("/settings/helpdesk");
}

export async function deleteCannedReply(id: string): Promise<void> {
  const user = await requirePermission("cases.manage");
  await prisma.cannedReply.delete({ where: { id } });
  await logAudit({ action: "helpdesk.canned_deleted", summary: "Deleted a saved reply", user });
  revalidatePath("/settings/helpdesk");
}

export async function deleteTag(id: string): Promise<void> {
  const user = await requirePermission("cases.manage");
  await prisma.supportTag.delete({ where: { id } });
  await logAudit({ action: "helpdesk.tag_deleted", summary: "Deleted a tag", user });
  revalidatePath("/settings/helpdesk");
}
