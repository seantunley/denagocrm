import "server-only";
import { prisma } from "./db";
import { formatZAR } from "./format";
import { ownedWriteTenantId } from "./tenantWrite";
import { canAccessContact, canAccessLead, canAccessQuote, type PermissionUser } from "./permissions";
import {
  TASK_PROMPT_MAX,
  TASK_STALE_DAYS,
  mergeTask,
  readDetails,
  readSteps,
  type TaskDetails,
  type TaskKind,
  type TaskStatus,
  type TaskUpdate,
  type TaskView,
} from "./assistantTaskRules";

/*
 * DAX's JOB SHEETS — the database half (the rules are assistantTaskRules.ts).
 *
 * PRIVATE TO THE PERSON, IN THEIR WORKSPACE: every read and write names the
 * workspace (ownedWriteTenantId) and the person, on top of RLS — someone else's
 * sheet id, even in the same workspace, is simply not found.
 *
 * RE-CHECKED ON EVERY LOAD: a customer, deal or quote id on a sheet is shown
 * only while the person may still open that record (a deal reassigned away
 * from them disappears from the sheet they read, not just from their lists).
 *
 * ONE WRITER AT A TIME: WhatsApp and the CRM can answer for the same person at
 * once. Every write locks the sheet's row (SELECT … FOR UPDATE) inside ONE
 * callback transaction, and an answer that read an older version of the sheet
 * than the one now stored does not overwrite it — it says so instead.
 */

type User = PermissionUser;
const DAY = 86_400_000;
const staleBefore = (now = new Date()) => new Date(now.getTime() - TASK_STALE_DAYS * DAY);

/** A sheet row → what one question sees: ids the person may no longer open are blanked, the quote read as it is NOW. */
async function view(user: User, row: {
  id: string; kind: string; title: string; status: string; contactId: string | null; leadId: string | null; quoteId: string | null;
  details: unknown; steps: unknown; nextAction: string | null; version: number; updatedAt: Date;
}): Promise<TaskView> {
  const [contactOk, leadOk, quoteOk] = await Promise.all([
    row.contactId ? canAccessContact(user, row.contactId) : false,
    row.leadId ? canAccessLead(user, row.leadId) : false,
    row.quoteId ? canAccessQuote(user, row.quoteId) : false,
  ]);
  const q = quoteOk && row.quoteId
    ? await prisma.quote.findFirst({
        where: { id: row.quoteId, deletedAt: null },
        select: { number: true, status: true, items: { select: { description: true, qty: true, colorPreference: true, discountPct: true } }, fees: { select: { label: true, amountCents: true } } },
      })
    : null;
  return {
    id: row.id,
    kind: row.kind as TaskKind,
    title: row.title,
    status: row.status as TaskStatus,
    contactId: contactOk ? row.contactId : null,
    leadId: leadOk ? row.leadId : null,
    // Kept even when it can't be opened now: the sheet still HAS a quote, so it must never build a second one.
    quoteId: row.quoteId,
    quote: q
      ? {
          number: q.number,
          status: q.status,
          lines: q.items.map((i) => `${i.qty} × ${i.description}${i.colorPreference ? ` (${i.colorPreference})` : ""}${i.discountPct > 0 ? `, less ${i.discountPct}%` : ""}`),
          fees: q.fees.map((f) => `${f.label} — ${formatZAR(f.amountCents)}`),
        }
      : null,
    details: readDetails(row.details),
    steps: readSteps(row.steps),
    nextAction: row.nextAction,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

const SELECT = {
  id: true, kind: true, title: true, status: true, contactId: true, leadId: true, quoteId: true,
  details: true, steps: true, nextAction: true, version: true, updatedAt: true,
} as const;

/** The person's open sheets with activity in the last 14 days, newest first — what each question starts from. */
export async function openTasks(user: User, take = TASK_PROMPT_MAX, now = new Date()): Promise<TaskView[]> {
  const rows = await prisma.assistantTask.findMany({
    where: { tenantId: ownedWriteTenantId(), userId: user.id, status: "open", updatedAt: { gte: staleBefore(now) } },
    orderBy: { updatedAt: "desc" },
    take,
    select: SELECT,
  });
  return Promise.all(rows.map((row) => view(user, row)));
}

/**
 * Everything on the Ask page: open sheets, and the ones finished or closed in
 * the last 30 days (still findable — and reopenable). An open sheet past 14
 * days without activity is shown as closed even before the nightly sweep marks it.
 */
export async function tasksForAskPage(userId: string, now = new Date()) {
  const rows = await prisma.assistantTask.findMany({
    where: { tenantId: ownedWriteTenantId(), userId, updatedAt: { gte: new Date(now.getTime() - 30 * DAY) } },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, status: true, quoteId: true, nextAction: true, updatedAt: true, closedAt: true },
  });
  return rows.map((row) => ({ ...row, status: row.status === "open" && row.updatedAt < staleBefore(now) ? "closed" : row.status }));
}

/** The sheet as it stands after this answer's write — what a quote card on it is filled from. */
export type TaskSheet = { id: string; kind: TaskKind; contactId: string | null; leadId: string | null; quoteId: string | null; details: TaskDetails };
export type TaskWrite =
  | { ok: true; id: string; title: string; created: boolean; status: TaskStatus; sheet: TaskSheet }
  | { ok: false; title: string };

/**
 * Write what the answer step said about a sheet. `loaded` is what THIS question
 * read: an id the model gave that is not one of them starts a new sheet (it
 * never reaches somebody else's, or one it was not shown). Under the row lock,
 * a sheet changed since it was read (WhatsApp and the CRM at once, or a Confirm
 * meanwhile) is left as it is, and the caller says so.
 *
 * The update's contactId / leadId must already have been through keepIds.
 */
export async function applyTaskUpdate(user: User, update: TaskUpdate, loaded: readonly TaskView[], now = new Date()): Promise<TaskWrite | null> {
  const tenantId = ownedWriteTenantId();
  const known = update.id ? loaded.find((t) => t.id === update.id && t.kind === update.kind) : undefined;
  if (!known) {
    // A NEW sheet needs a name; "closed" or "done" for a sheet that never existed is nothing to write.
    if (!update.title || (update.status && update.status !== "open")) return null;
    const merged = mergeTask(null, update);
    const row = await prisma.assistantTask.create({
      data: {
        tenantId, userId: user.id, kind: update.kind, title: merged.title, status: "open",
        contactId: merged.contactId, leadId: merged.leadId, details: merged.details as object, steps: merged.steps as object,
        nextAction: merged.nextAction, updatedAt: now,
      },
      select: { id: true, title: true },
    });
    return {
      ok: true, id: row.id, title: row.title, created: true, status: "open",
      sheet: { id: row.id, kind: update.kind, contactId: merged.contactId, leadId: merged.leadId, quoteId: null, details: merged.details },
    };
  }
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "AssistantTask" WHERE "id" = ${known.id} AND "tenantId" = ${tenantId} AND "userId" = ${user.id} FOR UPDATE`;
    if (!locked.length) return null;
    const row = await tx.assistantTask.findFirst({ where: { id: known.id, tenantId, userId: user.id }, select: SELECT });
    if (!row) return null;
    if (row.version !== known.version) return { ok: false as const, title: row.title };
    const merged = mergeTask({ ...row, details: readDetails(row.details), steps: readSteps(row.steps) }, update);
    const finished = merged.status !== "open";
    await tx.assistantTask.updateMany({
      where: { id: row.id, tenantId, userId: user.id },
      data: {
        title: merged.title, status: merged.status, contactId: merged.contactId, leadId: merged.leadId,
        details: merged.details as object, steps: merged.steps as object, nextAction: merged.nextAction,
        version: { increment: 1 }, updatedAt: now, closedAt: finished ? now : null,
      },
    });
    return {
      ok: true as const, id: row.id, title: merged.title, created: false, status: merged.status as TaskStatus,
      sheet: { id: row.id, kind: row.kind as TaskKind, contactId: merged.contactId, leadId: merged.leadId, quoteId: merged.quoteId, details: merged.details },
    };
  });
}

/**
 * A card that came from a sheet was CONFIRMED: record it on the sheet. The
 * quote id is the one the CRM just created (never the model's), set only if the
 * sheet has none — one sheet, one quote. `taskId` came back from the browser
 * with the card, so it is only ever looked up as the confirmer's own sheet.
 * Never throws: the quote is saved whatever happens here.
 */
export async function recordTaskProgress(userId: string, taskId: unknown, progress: { quoteId?: string; done: string }, now = new Date()): Promise<void> {
  if (typeof taskId !== "string" || !/^[\w-]{10,64}$/.test(taskId)) return;
  const tenantId = ownedWriteTenantId();
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "AssistantTask" WHERE "id" = ${taskId} AND "tenantId" = ${tenantId} AND "userId" = ${userId} FOR UPDATE`;
    if (!locked.length) return;
    const row = await tx.assistantTask.findFirst({ where: { id: taskId, tenantId, userId }, select: { quoteId: true, steps: true, status: true } });
    if (!row) return;
    const steps = readSteps(row.steps);
    await tx.assistantTask.updateMany({
      where: { id: taskId, tenantId, userId },
      data: {
        ...(progress.quoteId && !row.quoteId ? { quoteId: progress.quoteId } : {}),
        steps: { done: [...new Set([...steps.done, progress.done])].slice(-12), outstanding: steps.outstanding } as object,
        // Working on it again is activity: a sheet closed on its own while its card waited comes back.
        ...(row.status === "closed" ? { status: "open", closedAt: null } : {}),
        version: { increment: 1 },
        updatedAt: now,
      },
    });
  }).catch(() => {});
}

/** Close or reopen the person's OWN sheet (the Ask page). False when it is not theirs, or not there. */
export async function setTaskStatus(userId: string, taskId: string, status: "open" | "closed", now = new Date()): Promise<{ kind: string } | null> {
  const tenantId = ownedWriteTenantId();
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "AssistantTask" WHERE "id" = ${String(taskId)} AND "tenantId" = ${tenantId} AND "userId" = ${userId} FOR UPDATE`;
    if (!locked.length) return null;
    const row = await tx.assistantTask.findFirst({ where: { id: String(taskId), tenantId, userId }, select: { kind: true } });
    if (!row) return null;
    await tx.assistantTask.updateMany({
      where: { id: String(taskId), tenantId, userId },
      // Reopening is activity (it gets another 14 days); closing is not.
      data: status === "open" ? { status, closedAt: null, updatedAt: now, version: { increment: 1 } } : { status, closedAt: now, version: { increment: 1 } },
    });
    return row;
  });
}
