import "server-only";

/**
 * DRAFTS AND SCHEDULED SENDS from the email composer (Sean, 2026-10-15).
 *
 * A DRAFT is kept as it is written, for its author only, so closing the composer
 * or the tab loses nothing. A SCHEDULED send is an email the author chose to send
 * later: every check Send makes is run when it is scheduled (sendComposerForm's
 * check), and all of them again when the scheduled-emails cron sends it, as that
 * person, with their permissions as they are THEN. Scheduled sends on a record
 * are listed on it for everyone who can open it, with who scheduled them and
 * when they go — nothing reaches a customer that nobody can see coming.
 *
 * A send is claimed (scheduled → sending) in one statement before anything else
 * happens, so two cron runs can never send it twice. One that stops in "sending"
 * stays there, shown as "may have gone — check the timeline", and is never retried.
 */
import { basePrisma, prisma } from "@/lib/db";
import { canAccessContact, canAccessLead, CUSTOMER_RECORD_WRITE_PERMISSIONS, hasAnyPermission, type PermissionUser } from "@/lib/permissions";
import { getUserPermissions, RBAC_UNAVAILABLE } from "@/lib/permissionQuery";
import { resolveTenantMemberUser } from "@/lib/tenantActor";
import { currentTenantScope, runInTenantScope } from "@/lib/tenantScope";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { sendComposerForm, tenantIdFor } from "@/lib/composerSend";
import { emailUploads } from "@/lib/emailUploads";
import { deleteFile, readFile, saveFile, storesPrivately } from "@/lib/storage";
import { logAudit } from "@/lib/audit";
import { formatDateTime } from "@/lib/format";
import { redactSensitive } from "@/lib/sendCheck";
import { logError } from "@/lib/errorLog";

/** The earliest a send can be scheduled, and the furthest ahead. */
const MIN_AHEAD_MS = 60_000;
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
/** A draft keeps pasted pictures in its HTML; beyond this it is too big to keep. */
const MAX_DRAFT_HTML = 6_000_000;

type StoredFile = { name: string; type: string; size: number; storedRef: string };

/** What the composer holds, as a draft keeps it. Files from the computer are never kept in a draft. */
export type DraftFields = {
  to: string;
  cc: string;
  bcc: string;
  replyTo: string;
  subject: string;
  bodyHtml: string;
  contactId: string | null;
  leadId: string | null;
  attachIds: string[];
  quoteIds: string[];
  banner: string;
  secureLinks: boolean;
  secureDays: number | null;
  inReplyToId: string | null;
};

const text = (value: unknown, max: number) => String(value ?? "").slice(0, max);
const ids = (value: unknown) => (Array.isArray(value) ? value.map((id) => text(id, 64)).filter(Boolean).slice(0, 30) : []);

function draftFields(input: Partial<DraftFields>): DraftFields {
  return {
    to: text(input.to, 2000),
    cc: text(input.cc, 2000),
    bcc: text(input.bcc, 2000),
    replyTo: text(input.replyTo, 1000),
    subject: text(input.subject, 500),
    bodyHtml: text(input.bodyHtml, MAX_DRAFT_HTML + 1),
    contactId: text(input.contactId, 64) || null,
    leadId: text(input.leadId, 64) || null,
    attachIds: ids(input.attachIds),
    quoteIds: ids(input.quoteIds),
    banner: text(input.banner, 64),
    secureLinks: Boolean(input.secureLinks),
    secureDays: Number.isFinite(Number(input.secureDays)) && input.secureDays ? Math.round(Number(input.secureDays)) : null,
    inReplyToId: text(input.inReplyToId, 64) || null,
  };
}

/** May this person see and write on the record the draft is about? A draft names a record it was opened on. */
async function mayUseRecord(user: PermissionUser, contactId: string | null, leadId: string | null): Promise<boolean> {
  if (contactId && !(await canAccessContact(user, contactId))) return false;
  if (leadId && !(await canAccessLead(user, leadId))) return false;
  return Boolean(contactId || leadId);
}

/**
 * Keep the composer's contents as a draft (a new one, or the author's own draft
 * `id`). Returns its id. Nothing is kept for an email with nothing in it.
 */
export async function saveDraft(user: PermissionUser, id: string | null, input: Partial<DraftFields>): Promise<{ id?: string; error?: string }> {
  const fields = draftFields(input);
  if (fields.bodyHtml.length > MAX_DRAFT_HTML) return { error: "This email is too big to keep as a draft — it has very large pictures in it." };
  if (!(await mayUseRecord(user, fields.contactId, fields.leadId))) return { error: "You don't have access to that customer." };
  const tenantId = await tenantIdFor(user.id);
  if (!tenantId) return { error: "No workspace attached to this sign-in — sign out and back in." };
  if (id) {
    // The author's own DRAFT only: a scheduled send is not changed by an autosave.
    const updated = await prisma.emailDraft.updateMany({ where: { id, tenantId, userId: user.id, status: "draft" }, data: fields });
    if (updated.count === 1) return { id };
  }
  const created = await prisma.emailDraft.create({ data: { ...fields, tenantId, userId: user.id, status: "draft" }, select: { id: true } });
  return { id: created.id };
}

/** The author's draft is done with — sent, or discarded. */
export async function finishDraft(user: PermissionUser, id: string): Promise<void> {
  const tenantId = await tenantIdFor(user.id);
  if (!tenantId) return;
  await prisma.emailDraft.deleteMany({ where: { id, tenantId, userId: user.id, status: "draft" } });
}

export type DraftSummary = {
  id: string;
  status: string;
  subject: string;
  to: string;
  sendAt: string | null;
  updatedAt: string;
  error: string | null;
  mine: boolean;
  author: string;
};

/**
 * What waits on this record: the caller's own drafts, and EVERY scheduled,
 * sending or failed send on it, whoever wrote it.
 */
export async function draftsOnRecord(user: PermissionUser, contactId: string | null, leadId: string | null): Promise<DraftSummary[]> {
  if (!(await mayUseRecord(user, contactId, leadId))) return [];
  const tenantId = await tenantIdFor(user.id);
  if (!tenantId) return [];
  const rows = await prisma.emailDraft.findMany({
    where: {
      tenantId,
      ...(leadId ? { leadId } : { contactId }),
      OR: [{ status: "draft", userId: user.id }, { status: { in: ["scheduled", "sending", "failed"] } }],
    },
    orderBy: [{ sendAt: "asc" }, { updatedAt: "desc" }],
    take: 30,
    select: { id: true, status: true, subject: true, to: true, sendAt: true, updatedAt: true, error: true, userId: true },
  });
  const names = new Map(
    (await basePrisma.user.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.userId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    subject: row.subject,
    to: row.to,
    sendAt: row.sendAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    error: row.error,
    mine: row.userId === user.id,
    author: names.get(row.userId) ?? "A colleague",
  }));
}

/**
 * Open the author's draft in the composer. A SCHEDULED or FAILED send of theirs
 * becomes a draft again to be edited (scheduled → draft in one statement, so it
 * cannot be sent while it is being changed); files from the computer it carried
 * are deleted, and the composer says to attach them again.
 */
export async function openDraft(user: PermissionUser, id: string): Promise<{ draft?: DraftFields & { id: string }; filesDropped?: string[]; error?: string }> {
  const tenantId = await tenantIdFor(user.id);
  if (!tenantId) return { error: "No workspace attached to this sign-in — sign out and back in." };
  const row = await prisma.emailDraft.findFirst({ where: { id, tenantId, userId: user.id } });
  if (!row || !["draft", "scheduled", "failed"].includes(row.status)) return { error: "That email is no longer waiting — it may have been sent." };
  if (!(await mayUseRecord(user, row.contactId, row.leadId))) return { error: "You don't have access to that customer." };
  let dropped: string[] = [];
  if (row.status !== "draft") {
    const back = await prisma.emailDraft.updateMany({ where: { id, tenantId, userId: user.id, status: row.status }, data: { status: "draft", sendAt: null, error: null, files: [] } });
    if (back.count !== 1) return { error: "That email is being sent right now." };
    dropped = await dropStoredFiles(row.files);
    if (row.status === "scheduled") {
      await logAudit({ action: "email.unscheduled", summary: `Took back a scheduled email to ${row.to} to edit it: “${redactSensitive(row.subject)}”`, contactId: row.contactId, leadId: row.leadId, user });
    }
  }
  return {
    draft: {
      id: row.id,
      ...draftFields({ ...row, secureDays: row.secureDays ?? null }),
    },
    filesDropped: dropped,
  };
}

/** Cancel a scheduled send: its author, or the workspace owner. It is kept as cancelled, not deleted. */
export async function cancelScheduled(user: PermissionUser, id: string): Promise<{ error?: string }> {
  const tenantId = await tenantIdFor(user.id);
  if (!tenantId) return { error: "No workspace attached to this sign-in — sign out and back in." };
  const row = await prisma.emailDraft.findFirst({ where: { id, tenantId }, select: { userId: true, status: true, to: true, subject: true, contactId: true, leadId: true, files: true } });
  if (!row) return { error: "That scheduled email no longer exists." };
  if (row.userId !== user.id && user.role !== "owner") return { error: "Only the person who scheduled it, or the owner, can cancel it." };
  if (!(await mayUseRecord(user, row.contactId, row.leadId))) return { error: "You don't have access to that customer." };
  const done = await prisma.emailDraft.updateMany({ where: { id, tenantId, status: { in: ["scheduled", "failed"] } }, data: { status: "cancelled" } });
  if (done.count !== 1) return { error: row.status === "sending" || row.status === "sent" ? "Too late — it has already gone, or is going now." : "It was not waiting to be sent." };
  await dropStoredFiles(row.files);
  await logAudit({ action: "email.schedule_cancelled", summary: `Cancelled a scheduled email to ${row.to}: “${redactSensitive(row.subject)}”`, contactId: row.contactId, leadId: row.leadId, user });
  return {};
}

/** Delete the private copies a scheduled send kept of files from the computer; their names, for telling the person. */
async function dropStoredFiles(files: unknown): Promise<string[]> {
  const list = Array.isArray(files) ? (files as StoredFile[]) : [];
  for (const file of list) {
    await deleteFile(file.storedRef).catch((error) => logError("email-schedule-files", error).catch(() => {}));
  }
  return list.map((file) => file.name);
}

/**
 * Schedule the email the form describes, for `when` (an ISO time from the
 * browser). Every check Send makes runs now; the files from the computer are
 * stored privately until it goes. The draft it was written in becomes the
 * scheduled send.
 */
export async function scheduleComposerEmail(user: PermissionUser, formData: FormData, when: string, draftId: string | null): Promise<{ ok?: string; error?: string }> {
  const sendAt = new Date(when);
  const ahead = sendAt.getTime() - Date.now();
  if (!Number.isFinite(ahead)) return { error: "Choose when it should go." };
  if (ahead < MIN_AHEAD_MS) return { error: "Choose a time at least a minute from now — or press Send." };
  if (ahead > MAX_AHEAD_MS) return { error: "An email can be scheduled up to a year ahead." };
  const checked = await sendComposerForm(user, formData, { check: true });
  if (checked.error) return { error: checked.error.replace("Press Send again", "Press Schedule again") };
  const tenantId = await tenantIdFor(user.id);
  if (!tenantId) return { error: "No workspace attached to this sign-in — sign out and back in." };
  const uploads = emailUploads(formData);
  if ("error" in uploads) return { error: uploads.error };
  if (uploads.files.length > 0 && !storesPrivately()) {
    return { error: "Files from your computer can only wait for a scheduled send in the private file store, which is not switched on. Attach them from the library, or send now." };
  }
  const files: StoredFile[] = [];
  try {
    for (const file of uploads.files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const type = file.type || "application/octet-stream";
      files.push({ name: file.name, type, size: buffer.length, storedRef: await saveFile(buffer, file.name, type, tenantId) });
    }
  } catch {
    await dropStoredFiles(files);
    return { error: "The files could not be stored to send later. Nothing was scheduled — try again." };
  }
  const field = (name: string) => String(formData.get(name) ?? "");
  const data = {
    ...draftFields({
      to: field("to"), cc: field("cc"), bcc: field("bcc"), replyTo: field("replyTo"), subject: field("subject").trim(), bodyHtml: field("bodyHtml"),
      contactId: checked.filing?.contactId ?? null, leadId: checked.filing?.leadId ?? null,
      attachIds: formData.getAll("attach").map(String), quoteIds: formData.getAll("attachQuote").map(String),
      banner: field("banner"), secureLinks: formData.get("secureLinks") === "on", secureDays: Number(field("secureDays")) || null,
      inReplyToId: field("inReplyTo") || null,
    }),
    files,
    sensitiveOk: formData.get("sensitiveOk") === "1",
    status: "scheduled",
    sendAt,
    error: null,
  };
  let id: string | null = null;
  if (draftId) {
    const moved = await prisma.emailDraft.updateMany({ where: { id: draftId, tenantId, userId: user.id, status: "draft" }, data });
    if (moved.count === 1) id = draftId;
  }
  if (!id) id = (await prisma.emailDraft.create({ data: { ...data, tenantId, userId: user.id }, select: { id: true } })).id;
  await logAudit({
    action: "email.scheduled",
    summary: `Scheduled an email to ${data.to} for ${formatDateTime(sendAt)}: “${redactSensitive(data.subject)}”${checked.warning ? ` — after a sensitive-data warning (${checked.warning.kinds.join(", ")})` : ""}`,
    contactId: data.contactId,
    leadId: data.leadId,
    user,
  });
  return { ok: `Scheduled — it goes to ${data.to} on ${formatDateTime(sendAt)}. It is listed on this record until then, and can be cancelled.` };
}

/**
 * The person a scheduled send goes as, checked at the moment it goes as a sign-in
 * would be: an active member of THIS workspace who may still write to customers.
 * Null: they may not, and it is not sent. Throws when permissions cannot be read,
 * so a database blip puts the send back rather than failing it.
 */
async function scheduledSenderFor(userId: string): Promise<PermissionUser | null> {
  const scope = currentTenantScope();
  if (scope?.system) return null;
  if (tenantEnforcing() && !scope?.tenantId) return null;
  const member = await resolveTenantMemberUser(userId);
  if (!member) return null;
  const user = await basePrisma.user.findUnique({ where: { id: member.id }, select: { id: true, name: true, email: true, role: true } });
  if (!user) return null;
  if (user.role !== "owner" && (await getUserPermissions(user.id)).has(RBAC_UNAVAILABLE)) throw new Error("scheduled email: permissions unavailable");
  return (await hasAnyPermission(user, ...CUSTOMER_RECORD_WRITE_PERMISSIONS)) ? user : null;
}

/** The form Send would have posted, rebuilt from a scheduled send — so it goes through the same checks. */
async function formFor(row: Awaited<ReturnType<typeof prisma.emailDraft.findFirstOrThrow>>): Promise<FormData> {
  const form = new FormData();
  for (const name of ["to", "cc", "bcc", "replyTo", "subject", "bodyHtml", "banner"] as const) form.set(name, row[name]);
  if (row.contactId) form.set("contactId", row.contactId);
  if (row.leadId) form.set("leadId", row.leadId);
  if (row.secureLinks) form.set("secureLinks", "on");
  if (row.secureDays) form.set("secureDays", String(row.secureDays));
  for (const id of row.attachIds) form.append("attach", id);
  for (const id of row.quoteIds) form.append("attachQuote", id);
  for (const file of (Array.isArray(row.files) ? row.files : []) as StoredFile[]) {
    form.append("upload", new File([new Uint8Array(await readFile(file.storedRef))], file.name, { type: file.type }));
  }
  if (row.sensitiveOk) form.set("sensitiveOk", "1");
  if (row.inReplyToId) form.set("inReplyTo", row.inReplyToId);
  form.set("scheduledSend", "1");
  form.set("revalidate", row.leadId ? `/leads/${row.leadId}` : `/contacts/${row.contactId}`);
  return form;
}

/** Send one scheduled email that is due, if it is still waiting. */
async function sendScheduled(id: string, tenantId: string): Promise<"sent" | "failed" | "skipped"> {
  const claimed = await prisma.emailDraft.updateMany({ where: { id, tenantId, status: "scheduled", sendAt: { lte: new Date() } }, data: { status: "sending" } });
  if (claimed.count !== 1) return "skipped";
  const row = await prisma.emailDraft.findFirstOrThrow({ where: { id, tenantId } });
  const fail = async (error: string) => {
    await prisma.emailDraft.updateMany({ where: { id, tenantId, status: "sending" }, data: { status: "failed", error } });
    return "failed" as const;
  };
  let user: PermissionUser | null;
  try {
    user = await scheduledSenderFor(row.userId);
  } catch {
    // Could not read who they are: put it back for the next run rather than fail it.
    await prisma.emailDraft.updateMany({ where: { id, tenantId, status: "sending" }, data: { status: "scheduled" } });
    return "skipped";
  }
  if (!user) return fail("Not sent: the person who scheduled it can no longer send emails from this CRM.");
  let result: Awaited<ReturnType<typeof sendComposerForm>>;
  try {
    result = await sendComposerForm(user, await formFor(row));
  } catch (error) {
    await logError("scheduled-email", error, `draft ${id}`, { tenantId }).catch(() => {});
    return fail("Something went wrong while sending. It may not have gone — check the timeline before sending it again.");
  }
  if (!result.ok) return fail(`Not sent: ${result.error ?? "it could not be sent."}`);
  await prisma.emailDraft.updateMany({ where: { id, tenantId }, data: { status: "sent", communicationId: result.communicationId ?? null, error: null } });
  await dropStoredFiles(row.files);
  await prisma.emailDraft.updateMany({ where: { id, tenantId }, data: { files: [] } });
  return "sent";
}

/**
 * The cron's work: every scheduled send that is due, oldest first, each bound to
 * its own workspace. `tenantId` null (enforcement off) covers every workspace.
 */
export async function sendDueScheduledEmails(
  tenantId: string | null,
  budget: { shouldStop: (reserveMs?: number) => boolean },
  limit = 20,
): Promise<{ sent: number; failed: number }> {
  const due = await prisma.emailDraft.findMany({
    where: { ...(tenantId ? { tenantId } : {}), status: "scheduled", sendAt: { lte: new Date() } },
    orderBy: { sendAt: "asc" },
    take: limit,
    select: { id: true, tenantId: true },
  });
  const stats = { sent: 0, failed: 0 };
  for (const row of due) {
    if (budget.shouldStop(10_000)) break;
    const outcome = await runInTenantScope({ tenantId: row.tenantId, system: false }, () => sendScheduled(row.id, row.tenantId));
    if (outcome === "sent") stats.sent += 1;
    if (outcome === "failed") stats.failed += 1;
  }
  return stats;
}
