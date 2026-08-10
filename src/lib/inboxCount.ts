import "server-only";
import { prisma } from "./db";
import { accessibleInboxWhere, type PermissionUser } from "./permissions";
import type { Prisma } from "@prisma/client";

const DM_CHANNELS = ["whatsapp", "messenger", "instagram"];

/**
 * The newest `occurredAt` of every thread matching `where`, keyed the way the
 * inbox keys threads: by contact when there is one, by lead otherwise.
 *
 * Two groupings rather than one, for the same reason inboxQuery needs two — a
 * conversation counted under both keys would be counted twice. The lead pass
 * therefore excludes rows that already carry a contact.
 */
async function newestPerThread(where: Prisma.CommunicationWhereInput): Promise<Map<string, number>> {
  const [byContact, byLead] = await Promise.all([
    prisma.communication.groupBy({
      by: ["contactId", "type"],
      where: { ...where, contactId: { not: null } },
      _max: { occurredAt: true },
    }),
    prisma.communication.groupBy({
      by: ["leadId", "type"],
      where: { ...where, contactId: null, leadId: { not: null } },
      _max: { occurredAt: true },
    }),
  ]);

  const newest = new Map<string, number>();
  for (const row of byContact) {
    if (row._max.occurredAt) newest.set(`c:${row.contactId}:${row.type}`, row._max.occurredAt.getTime());
  }
  for (const row of byLead) {
    if (row._max.occurredAt) newest.set(`l:${row.leadId}:${row.type}`, row._max.occurredAt.getTime());
  }
  return newest;
}

/**
 * Unread inbound threads — powers the sidebar badge. A thread counts when its
 * newest message is inbound AND not yet opened (readAt null). Opening the thread
 * in the inbox clears it, so the badge reflects "needs your eyes" rather than
 * "needs a reply" — a read-but-unreplied thread stays visible in the inbox (with
 * a "Read" pill) but no longer nags here.
 *
 * This used to read the newest 400 rows and group them afterwards, which made the
 * badge a function of message VOLUME rather than of unread threads: one busy
 * conversation could fill the whole slice, and every thread whose newest message
 * fell outside it — including unread ones — was silently not counted. The badge
 * then under-reported, which is the worst direction for it to be wrong in: it
 * says "you are caught up" about conversations nobody has opened.
 *
 * Asking the database for the newest message per thread removes the slice
 * entirely. Two aggregates: when each thread was last active at all, and when it
 * was last active with an unopened inbound message. Those agree exactly when the
 * newest message IS an unopened inbound one, which is the definition above — and
 * no row budget stands between a quiet unread thread and the badge.
 *
 * Scoped to the caller's accessible contacts/leads, so the badge counts only
 * conversations that user can open; view_all users see the global count as
 * before. It deliberately counts ALL such threads, not just the page of them the
 * inbox lists first — a badge that stopped at the visible page would go back to
 * under-reporting the moment the workspace had more conversations than one page.
 */
export async function awaitingReplyCount(user: PermissionUser): Promise<number> {
  const scopeWhere = await accessibleInboxWhere(user);
  const base: Prisma.CommunicationWhereInput = {
    type: { in: DM_CHANNELS },
    ...scopeWhere,
    archivedAt: null,
  };

  const [lastActivity, lastUnreadInbound] = await Promise.all([
    newestPerThread(base),
    newestPerThread({ ...base, direction: "inbound", readAt: null }),
  ]);

  let unread = 0;
  for (const [key, at] of lastUnreadInbound) {
    if (lastActivity.get(key) === at) unread += 1; // newest is theirs & unopened
  }
  return unread;
}
