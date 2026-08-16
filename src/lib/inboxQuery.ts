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

const DM_CHANNELS = ["whatsapp", "messenger", "instagram", "x"];

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
 * The newest MESSAGES_PER_THREAD rows OF EACH selected thread.
 *
 * A single `take` over the union of the selected threads does NOT do this, and
 * getting that wrong reintroduces the very defect this file exists to fix one
 * step later: with `take: keys.length * MESSAGES_PER_THREAD`, fifty selected
 * threads share a 400-row budget that is still handed out in global recency
 * order, so one conversation carrying 400+ recent messages consumes all of it
 * and the other forty-nine arrive with ZERO rows. buildInboxThreads renders a
 * thread from its messages, so those threads disappear from the queue again —
 * selected, then starved.
 *
 * The limit has to apply per partition, which is what a window function is for.
 * Ranking happens in SQL and returns ids only; the rows themselves are then read
 * back through the guarded client, so the include, the soft-delete filter and
 * the caller's `scopeWhere` all still apply to what is actually returned.
 *
 * Tenancy holds across the raw step: the guarded client pins `app.current_tenant`
 * for $queryRaw exactly as it does for model operations (db.ts, "Layer 2b"), so
 * this ranks under the same RLS as the groupBy that chose the threads. Record
 * permissions hold too, and for a different reason: `keys` came from a groupBy
 * that had already applied `scopeWhere`, and every row of one thread shares that
 * thread's contact or lead — so restricting the ranking to those keys inherits
 * the permission filter rather than re-deriving it in SQL.
 */
const RANK_SQL = (archived: boolean) => `
  WITH keys AS (
    SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[]) AS k(kind, key_id, chan)
  ),
  thread_rows AS (
    SELECT c."id" AS id, k.kind AS kind, k.key_id AS key_id, k.chan AS chan,
           c."occurredAt" AS occurred_at
      FROM "Communication" c
      JOIN keys k
        ON k.chan = c."type"
       AND ((k.kind = 'contact' AND c."contactId" = k.key_id)
         OR (k.kind = 'lead' AND c."contactId" IS NULL AND c."leadId" = k.key_id))
     WHERE c."archivedAt" IS ${archived ? "NOT NULL" : "NULL"}
  ),
  ranked AS (
    SELECT id, ROW_NUMBER() OVER (
             PARTITION BY kind, key_id, chan
             ORDER BY occurred_at DESC, id DESC
           ) AS rn
      FROM thread_rows
  )
  SELECT id FROM ranked WHERE rn <= $4
`;

async function newestMessageIdsPerThread(
  keys: ThreadKey[],
  archived: boolean,
  perThread: number,
): Promise<string[]> {
  const kinds = keys.map((key) => (key.contactId ? "contact" : "lead"));
  const keyIds = keys.map((key) => (key.contactId ?? key.leadId) as string);
  const chans = keys.map((key) => key.type);
  const rows: Array<{ id: string }> = await prisma.$queryRawUnsafe(
    RANK_SQL(archived),
    kinds,
    keyIds,
    chans,
    perThread,
  );
  return rows.map((row) => row.id);
}

/**
 * Communication rows for the most recently active threads, newest first and
 * ready for buildInboxThreads().
 *
 * Every selected thread contributes its own newest messages, so neither which
 * conversations exist nor whether a conversation has any content depends on how
 * talkative its neighbours are.
 */
export async function loadInboxComms(
  scopeWhere: Prisma.CommunicationWhereInput,
  options: { archived?: boolean; threads?: number } = {},
) {
  const archived = options.archived ?? false;
  const limit = options.threads ?? THREAD_PAGE_SIZE;

  const keys = await recentThreadKeys(scopeWhere, archived, limit);
  if (keys.length === 0) return [];

  const ids = await newestMessageIdsPerThread(keys, archived, MESSAGES_PER_THREAD);
  if (ids.length === 0) return [];

  return prisma.communication.findMany({
    where: {
      id: { in: ids },
      type: { in: DM_CHANNELS },
      ...scopeWhere,
      archivedAt: archived ? { not: null } : null,
      OR: messagesForThreads(keys),
    },
    orderBy: { occurredAt: "desc" },
    include: { contact: true, lead: true },
  });
}
