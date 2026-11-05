import "server-only";
import { basePrisma } from "./db";
import { logError } from "./errorLog";
import { sendPushToAll } from "./push";
import { currentTenantScope, runInTenantScope } from "./tenantScope";
import { getUserPermissions, RBAC_UNAVAILABLE } from "./permissionQuery";
import { resolveTenantMemberUser } from "./tenantActor";
import { tenantEnforcing } from "./tenantEnforcement";
import { contactName } from "./format";
import {
  canAccessContact,
  canAccessConversation,
  canAccessJobCard,
  canAccessLead,
  getAccessibleContactIds,
  getAccessibleJobCardIds,
  getAccessibleLeadIds,
  type PermissionUser,
} from "./permissions";
import {
  mentionTitle,
  pushFor,
  recordHref,
  snippetOf,
  watchTitle,
  type RecordType,
  type WatchEvent,
  type WatchableType,
} from "./collaborationRules";

/*
 * @MENTIONS AND WATCHING (2026-11-05) — the database half; the rules are collaborationRules.ts.
 *
 * A person is told only about a record they may open, checked AS THEM (staffUserFor) when the notification is
 * made, and again whenever it is shown (visibleNotifications) — losing access to a customer hides what was said about
 * them. Nothing here ever reaches a customer. Every write names the workspace explicitly (bypass client).
 */

export type RecordRef = { type: RecordType; id: string };

/**
 * A member of THIS workspace, as a permission user — for deciding whether they may be told about a record. Unlike
 * assistantUserFor it does NOT ask for DAX's permissions or the Automation & AI module (review of #1005): a mention
 * is for any colleague who can open the record, AI or not. Whether they can is canOpenRecord's question, as them.
 * Null outside one workspace, for someone not (or no longer) a member, or a disabled account. A permissions read
 * that fails throws — "couldn't read" is not "may not see".
 */
export async function staffUserFor(userId: string): Promise<PermissionUser | null> {
  const scope = currentTenantScope();
  if (scope?.system) return null;
  if (tenantEnforcing() && !scope?.tenantId) return null;
  const member = await resolveTenantMemberUser(userId);
  if (!member) return null;
  const user = await basePrisma.user.findUnique({ where: { id: member.id }, select: { id: true, name: true, email: true, role: true } });
  if (!user) return null;
  if (user.role !== "owner" && (await getUserPermissions(user.id)).has(RBAC_UNAVAILABLE)) {
    throw new Error("collaboration: permissions unavailable");
  }
  return user;
}

export async function canOpenRecord(user: PermissionUser, ref: RecordRef): Promise<boolean> {
  if (ref.type === "lead") return canAccessLead(user, ref.id);
  if (ref.type === "contact") return canAccessContact(user, ref.id);
  if (ref.type === "jobcard") return canAccessJobCard(user, ref.id);
  return canAccessConversation(user, ref.id);
}

/** How the record is named in a notification: the deal's title, the customer's name, "Job #12". */
export async function recordLabel(tenantId: string, ref: RecordRef): Promise<string> {
  if (ref.type === "lead") {
    const lead = await basePrisma.lead.findFirst({ where: { id: ref.id, tenantId }, select: { title: true, name: true } });
    return lead?.title || lead?.name || "a deal";
  }
  if (ref.type === "contact") {
    const contact = await basePrisma.contact.findFirst({ where: { id: ref.id, tenantId }, select: { firstName: true, lastName: true, company: true, isCompany: true } });
    return contact ? contactName(contact) : "a customer";
  }
  if (ref.type === "jobcard") {
    const job = await basePrisma.jobCard.findFirst({ where: { id: ref.id, tenantId }, select: { number: true } });
    return job ? `Job #${job.number}` : "a job card";
  }
  const conversation = await basePrisma.conversation.findFirst({
    where: { id: ref.id, tenantId },
    select: { contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } }, lead: { select: { name: true } } },
  });
  return conversation?.contact ? contactName(conversation.contact) : conversation?.lead?.name ?? "a conversation";
}

type Notice = {
  tenantId: string;
  userIds: readonly string[];
  kind: "mention" | "watch";
  event?: WatchEvent;
  actorId?: string | null;
  ref: RecordRef;
  /** For a watch: the new stage or status. */
  detail?: string | null;
  snippet?: string | null;
};

/**
 * Tell these people. Returns who was told and who couldn't be (they can't open the record), by name, so the person
 * who wrote the note can be told plainly. The actor is never told about their own note.
 */
export async function notifyPeople(notice: Notice): Promise<{ told: string[]; cannotSee: string[] }> {
  const { tenantId, ref, kind } = notice;
  return runInTenantScope({ tenantId, system: false }, async () => {
    const ids = [...new Set(notice.userIds)].filter((id) => id && id !== notice.actorId);
    const told: string[] = [];
    const cannotSee: string[] = [];
    if (!ids.length) return { told, cannotSee };
    const [label, actor] = await Promise.all([
      recordLabel(tenantId, ref),
      notice.actorId ? basePrisma.user.findUnique({ where: { id: notice.actorId }, select: { name: true } }) : null,
    ]);
    const actorName = actor?.name ?? null;
    const title = kind === "mention" ? mentionTitle(actorName ?? "Someone", label) : watchTitle(notice.event ?? "note", label, notice.detail);
    const href = recordHref(ref.type, ref.id);
    const snippet = snippetOf(notice.snippet);
    for (const userId of ids) {
      const user = await staffUserFor(userId);
      if (!user || !(await canOpenRecord(user, ref))) {
        if (user) cannotSee.push(user.name);
        continue;
      }
      // A watch says each kind of change once until it's read — a chatty WhatsApp thread is one notification.
      if (kind === "watch") {
        const unread = await basePrisma.staffNotification.findFirst({
          where: { tenantId, userId, kind, event: notice.event ?? null, recordType: ref.type, recordId: ref.id, readAt: null },
          select: { id: true },
        });
        if (unread) continue;
      }
      await basePrisma.staffNotification.create({
        data: { tenantId, userId, kind, event: notice.event ?? null, actorId: notice.actorId ?? null, recordType: ref.type, recordId: ref.id, title, snippet, href },
      });
      told.push(user.name);
      await sendPushToAll({ ...pushFor(kind, actorName), url: href }, kind, { tenantId, userId }).catch(() => 0);
    }
    return { told, cannotSee };
  });
}

/**
 * A note was saved: tell the people it @mentions and the record's watchers, and say who was told — the note is saved
 * whatever happens here, so a failure only changes the message. `picked` is what the mention box sent; mentionedIds
 * keeps only staff of this workspace whose @Name is still in the text.
 */
export async function tellAboutNote(input: {
  tenantId: string | null | undefined;
  actorId: string;
  text: string;
  picked: readonly string[];
  staff: readonly { id: string; name: string }[];
  mentionOn: RecordRef;
  watchRefs: readonly { type: WatchableType; id: string | null | undefined }[];
}): Promise<string> {
  if (!input.tenantId) return "Saved";
  try {
    const { mentionedIds } = await import("./collaborationRules");
    const named = mentionedIds(input.text, input.picked, input.staff);
    const result = named.length
      ? await notifyPeople({ tenantId: input.tenantId, userIds: named, kind: "mention", actorId: input.actorId, ref: input.mentionOn, snippet: input.text })
      : { told: [], cannotSee: [] };
    await notifyWatchers(input.tenantId, input.watchRefs, "note", { actorId: input.actorId, snippet: input.text });
    return savedMessage(result);
  } catch (error) {
    await logError("collaboration", "mention notification failed", error instanceof Error ? error.name : "unknown").catch(() => {});
    return "Saved, but the people you mentioned couldn't be told — mention them again or tell them yourself.";
  }
}

export function savedMessage(result: { told: string[]; cannotSee: string[] }): string {
  const parts = ["Saved"];
  if (result.told.length) parts.push(`told ${result.told.join(", ")}`);
  let message = parts.join(" — ");
  if (result.cannotSee.length) message += `. ${result.cannotSee.join(", ")} can't open this record, so ${result.cannotSee.length === 1 ? "wasn't" : "weren't"} told.`;
  return message;
}

/** Everyone watching any of these records (a note on a deal is news to the deal's and its customer's watchers). */
export async function notifyWatchers(
  tenantId: string,
  refs: readonly { type: WatchableType; id: string | null | undefined }[],
  event: WatchEvent,
  options: { actorId?: string | null; detail?: string | null; snippet?: string | null } = {},
): Promise<void> {
  const told = new Set<string>();
  for (const ref of refs) {
    if (!ref.id) continue;
    const watchers = await basePrisma.recordWatch.findMany({ where: { tenantId, recordType: ref.type, recordId: ref.id }, select: { userId: true } });
    const fresh = watchers.map((w) => w.userId).filter((id) => !told.has(id));
    fresh.forEach((id) => told.add(id));
    if (fresh.length) await notifyPeople({ tenantId, userIds: fresh, kind: "watch", event, ref: { type: ref.type, id: ref.id }, ...options });
  }
}

/**
 * The same, after the response — for paths a customer or a webhook is waiting on. Never throws, never slows them.
 */
export function notifyWatchersLater(...args: Parameters<typeof notifyWatchers>): void {
  const work = notifyWatchers(...args).catch((error: unknown) =>
    logError("collaboration", "watch notification failed", error instanceof Error ? error.name : "unknown").catch(() => {}),
  );
  void import("next/server")
    .then(({ after }) => after(() => work))
    .catch(() => {});
}

/**
 * A deal moved stage, was won or lost (leadJourneyEvents.ts — every path that moves a deal emits there). Whoever
 * made the change isn't told about it.
 */
export async function onLeadEvent(trigger: string, leadId: string): Promise<void> {
  if (trigger !== "stage_entered" && trigger !== "lead_won" && trigger !== "lead_lost") return;
  const { prisma } = await import("./db");
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { tenantId: true, contactId: true, stage: { select: { name: true } } } });
  if (!lead?.tenantId) return;
  const { getCurrentUser } = await import("./auth");
  const actor = await getCurrentUser().catch(() => null);
  const detail = trigger === "lead_won" ? "Won" : trigger === "lead_lost" ? "Lost" : lead.stage?.name ?? null;
  notifyWatchersLater(lead.tenantId, [{ type: "lead", id: leadId }, { type: "contact", id: lead.contactId }], "stage", { actorId: actor?.id ?? null, detail });
}

/** A customer's message arrived on a deal or customer (db.ts communication.create hook). */
export function onInboundMessage(data: { tenantId?: string | null; direction?: string | null; leadId?: string | null; contactId?: string | null; body?: string | null }): void {
  if (data.direction !== "inbound" || !data.tenantId || (!data.leadId && !data.contactId)) return;
  notifyWatchersLater(data.tenantId, [{ type: "lead", id: data.leadId }, { type: "contact", id: data.contactId }], "reply", { snippet: data.body });
}

/**
 * This person's notifications they may still see: each record re-checked through the CRM's own access lists (one
 * read per kind, not one per row).
 */
export async function visibleNotifications(user: PermissionUser, tenantId: string, take = 50) {
  const rows = await basePrisma.staffNotification.findMany({ where: { tenantId, userId: user.id }, orderBy: { createdAt: "desc" }, take });
  const [leadIds, contactIds, jobCardIds] = await Promise.all([
    getAccessibleLeadIds(user),
    getAccessibleContactIds(user),
    getAccessibleJobCardIds(user),
  ]);
  const allowed = (ids: string[] | null, id: string) => ids === null || ids.includes(id);
  const out = [];
  for (const row of rows) {
    const ok =
      row.recordType === "lead" ? allowed(leadIds, row.recordId)
        : row.recordType === "contact" ? allowed(contactIds, row.recordId)
          : row.recordType === "jobcard" ? allowed(jobCardIds, row.recordId)
            : await canAccessConversation(user, row.recordId);
    if (ok) out.push(row);
  }
  return out;
}

export async function unreadNotificationCount(tenantId: string, userId: string): Promise<number> {
  return basePrisma.staffNotification.count({ where: { tenantId, userId, readAt: null } });
}

/** Who is watching a record, for the Watch button ("You and 2 others"). */
export async function watchState(tenantId: string, userId: string, ref: { type: WatchableType; id: string }) {
  const rows = await basePrisma.recordWatch.findMany({ where: { tenantId, recordType: ref.type, recordId: ref.id }, select: { userId: true } });
  return { watching: rows.some((row) => row.userId === userId), count: rows.length };
}
