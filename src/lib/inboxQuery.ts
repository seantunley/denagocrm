import "server-only";
import { prisma } from "./db";
import type { Prisma } from "@prisma/client";

/**
 * Loading the inbox used to mean "take the newest 400 Communication rows, then
 * group them into threads". Selection therefore competed with volume: one busy
 * conversation could consume the whole budget and push other active — or unread —
 * threads out of the dataset entirely, so they vanished from the queue AND from
 * the unread count. Nothing surfaced that; the inbox simply looked emptier than
 * it was.
 *
 * Threads are now chosen FIRST, by when each was last active, and only then are
 * messages loaded for the threads that were chosen. A loud conversation can no
 * longer evict a quiet one, because the two are no longer drawn from one pool.
 *
 * This is the Phase 1 correctness fix, deliberately expressed on the current
 * model: threads are still grouped from Communication by contact-or-lead plus
 * channel. Making Conversation the canonical thread — and paginating on
 * `lastMessageAt` with a cursor — is Phase 2, and this shape is what that work
 * will replace rather than something it has to unpick.
 */

/** Conversations per page. The roadmap's recommended list size. */
export const THREAD_PAGE_SIZE = 50;

/** Messages materialised per thread for the list view. */
export const MESSAGES_PER_THREAD = 8;

const DM_CHANNELS = ["whatsapp", "messenger", "instagram"];

type ThreadKey = { contactId: string | null; leadId: string | null; type: string; lastAt: Date };

/**
 * The most recently active threads, newest first.
 *
 * Two groupings, because a thread is keyed by contact when there is one and by
 * lead otherwise — the same rule threadCollaborationKey states. The lead pass
 * therefore excludes rows that already have a contact, or a single conversation
 * would be counted under both keys.
 */
async function recentThreadKeys(
  scopeWhere: Prisma.CommunicationWhereInput,
  archived: boolean,
  limit: number,
): Promise<ThreadKey[]> {
  const base: Prisma.CommunicationWhereInput = {
    type: { in: DM_CHANNELS },
    ...scopeWhere,
    archivedAt: archived ? { not: null } : null,
  };

  const [byContact, byLead] = await Promise.all([
    prisma.communication.groupBy({
      by: ["contactId", "type"],
      where: { ...base, contactId: { not: null } },
      _max: { occurredAt: true },
      orderBy: { _max: { occurredAt: "desc" } },
      take: limit,
    }),
    prisma.communication.groupBy({
      by: ["leadId", "type"],
      where: { ...base, contactId: null, leadId: { not: null } },
      _max: { occurredAt: true },
      orderBy: { _max: { occurredAt: "desc" } },
      take: limit,
    }),
  ]);

  const keys: ThreadKey[] = [
    ...byContact.map((row) => ({
      contactId: row.contactId,
      leadId: null,
      type: row.type,
      lastAt: row._max.occurredAt ?? new Date(0),
    })),
    ...byLead.map((row) => ({
      contactId: null,
      leadId: row.leadId,
      type: row.type,
      lastAt: row._max.occurredAt ?? new Date(0),
    })),
  ];

  return keys.sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime()).slice(0, limit);
}

/** A `where` fragment matching exactly the given threads and nothing else. */
function messagesForThreads(keys: ThreadKey[]): Prisma.CommunicationWhereInput[] {
  return keys.map((key) =>
    key.contactId
      ? { contactId: key.contactId, type: key.type }
      : { leadId: key.leadId, contactId: null, type: key.type },
  );
}

/**
 * Communication rows for the most recently active threads, newest first and
 * ready for buildInboxThreads().
 *
 * The row budget is bounded by the threads actually selected rather than by the
 * whole table, so it can no longer decide WHICH conversations exist — only how
 * much of each is materialised.
 */
export async function loadInboxComms(
  scopeWhere: Prisma.CommunicationWhereInput,
  options: { archived?: boolean; threads?: number } = {},
) {
  const archived = options.archived ?? false;
  const limit = options.threads ?? THREAD_PAGE_SIZE;

  const keys = await recentThreadKeys(scopeWhere, archived, limit);
  if (keys.length === 0) return [];

  return prisma.communication.findMany({
    where: {
      type: { in: DM_CHANNELS },
      ...scopeWhere,
      archivedAt: archived ? { not: null } : null,
      OR: messagesForThreads(keys),
    },
    orderBy: { occurredAt: "desc" },
    take: keys.length * MESSAGES_PER_THREAD,
    include: { contact: true, lead: true },
  });
}
