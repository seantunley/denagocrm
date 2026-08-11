import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { currentTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";
import { inheritedTenantId } from "./tenantWrite";

/**
 * The tenantId the top-level guard (db.ts `scopeArgs`) will FILTER a Conversation
 * read/update by for the current scope. Conversation bookkeeping runs through
 * `basePrisma` (to avoid recursing back through the Communication create
 * extension), which BYPASSES that guard — so it must apply the same predicate
 * itself. Mirrors `scopeArgs` exactly: only enforcing + a non-system tenant scope
 * narrows anything, because while enforcement is dormant every legacy row carries
 * a NULL tenant and filtering on the acting tenant would simply stop matching
 * them — the thread would look empty and a bump would be a silent no-op.
 *
 * THIS IS A FILTER, AND ONLY A FILTER. It used to be the CREATE stamp as well,
 * and that was the bug: mirroring `scopeArgs` is right for a `where` and useless
 * for a `data`, because what `scopeArgs` stamps while enforcement is dormant is
 * nothing at all. Every conversation opened since therefore landed with a NULL
 * tenant (6 of 32 on production at the 2026-08-10 audit, 5 of them written after
 * the July backfill). See {@link conversationTenantId} for what a create uses.
 */
function conversationFilterTenantId(): string | null {
  if (!tenantEnforcing()) return null;
  const scope = currentTenantScope();
  if (!scope || scope.system) return null;
  return scope.tenantId ?? null;
}

/**
 * The tenantId a NEW conversation is stamped with.
 *
 * A conversation is opened by an INBOUND MESSAGE — a WhatsApp webhook, an IMAP
 * poll, a Messenger callback — so there is frequently no session to ask, and
 * asking the ambient scope alone is how this row came to be unowned in the first
 * place. The owner therefore comes, in order, from:
 *
 *   1. the COMMUNICATION being written. Under enforcement `scopeArgs` has already
 *      stamped `args.data.tenantId` by the time the communication extension runs
 *      (Layer 2 wraps Layer 1), and any caller that stamps it explicitly is making
 *      the same statement. This one matters beyond tidiness: the composite FK
 *      `Communication(tenantId, conversationId) → Conversation(tenantId, id)` is
 *      violated the moment the two disagree, so the message decides.
 *   2. the CONTACT OR LEAD the thread is about, read from the row itself. A
 *      conversation with Denago Cape Town's customer belongs to Denago Cape Town
 *      whichever process happened to receive the message.
 *   3. `inheritedTenantId`'s own ladder — the enforced scope, the channel scope
 *      `withChannelTenantScope` established from the provider endpoint the message
 *      arrived on, and finally the founding tenant.
 *
 * Never invents an owner: every rung is a fact about a real row or a real scope.
 *
 * RUNG 2 IS VERBATIM, INCLUDING NULL. When the thread has a subject, the subject
 * decides — even when its answer is "I have no owner yet". Climbing past a NULL
 * parent to the founding tenant is not a safe default here, it is a constraint
 * violation: `Conversation(tenantId, contactId) → Contact(tenantId, id)` is a
 * COMPOSITE foreign key, so a child claiming an owner its parent does not have
 * cannot be inserted at all. Postgres rejects it with P2003 and the inbound
 * message is lost.
 *
 * That is not hypothetical. Production is full of Contacts with a NULL tenantId
 * — the audit counted them — and the integration seed reproduces exactly that
 * population, which is how this surfaced.
 *
 * So the ladder only continues past rung 2 when there is NO subject to ask. A
 * conversation about an unowned contact is itself unowned, and a later backfill
 * claims the pair together, which is the only way they can stay consistent.
 */
async function conversationTenantId(data: MessageData): Promise<string | null> {
  if (typeof data.tenantId === "string" && data.tenantId) return data.tenantId;
  const subject = data.contactId
    ? await basePrisma.contact.findUnique({
        where: { id: data.contactId },
        select: { tenantId: true },
      })
    : data.leadId
      ? await basePrisma.lead.findUnique({ where: { id: data.leadId }, select: { tenantId: true } })
      : null;
  // A subject that exists answers for itself, null included — see above.
  if (subject) return subject.tenantId;
  return inheritedTenantId(null);
}

/** Map a Communication.type to a conversation channel. */
const CHANNEL_OF: Record<string, string> = {
  email: "email",
  whatsapp: "whatsapp",
  messenger: "messenger",
  instagram: "instagram",
  call: "call",
  meeting: "note",
  note: "note",
};

export function channelForType(type: string): string {
  return CHANNEL_OF[type] ?? "other";
}

type MessageData = {
  contactId?: string | null;
  leadId?: string | null;
  type: string;
  subject?: string | null;
  direction?: string | null;
  occurredAt?: Date;
  /**
   * The Communication's own owner, as it will be written. Present once the guard
   * has stamped it (under enforcement) or once a caller stamps it explicitly;
   * absent while enforcement is dormant and nobody has. Read, never assumed.
   */
  tenantId?: string | null;
};

/**
 * Find the open conversation a new message belongs to (per contact/lead + channel),
 * creating one if none exists. Returns null for messages with no contact or lead.
 * Uses basePrisma so it never recurses through the Communication create extension.
 */
export async function resolveConversationId(data: MessageData): Promise<string | null> {
  if (!data.contactId && !data.leadId) return null;
  const channel = channelForType(data.type);
  const filterTenantId = conversationFilterTenantId();
  const subjectScope = data.contactId ? { contactId: data.contactId } : { leadId: data.leadId };
  const existing = await basePrisma.conversation.findFirst({
    // Reuse only the acting tenant's own open conversation when a tenant is in scope.
    where: { channel, status: { not: "closed" }, ...(filterTenantId ? { tenantId: filterTenantId } : {}), ...subjectScope },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await basePrisma.conversation.create({
    data: {
      channel,
      subject: data.subject ?? null,
      contactId: data.contactId ?? null,
      leadId: data.leadId ?? null,
      // Resolved only on the CREATE branch, so the extra lookup is paid once per
      // thread rather than once per message.
      tenantId: await conversationTenantId(data),
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Rewrite a conversation's derived state from the messages that exist, holding
 * the conversation's row lock for the whole read-then-write.
 *
 * WHY ABSOLUTE, AND WHY EVERYWHERE.
 *
 * This used to roll the counters forward INCREMENTALLY — `messageCount: {
 * increment: 1 }` and friends — which is correct on its own and cannot be mixed
 * with anything else. The echo cleanup has to write ABSOLUTE values, because an
 * increment has no inverse that restores `lastMessageAt`, `lastDirection` or
 * `firstResponseAt` when the message that supplied them is removed. Absolute and
 * relative writers on one row do not compose:
 *
 *   cleanup                       a real new message
 *   ───────                       ──────────────────
 *                                 INSERT Communication  (committed)
 *   snapshot: 6 messages
 *   write messageCount = 6
 *                                 increment -> 7        ← one too high, for ever
 *
 * and the mirror image, where the cleanup's snapshot predates the insert and its
 * absolute write throws the increment away. A lock around the cleanup alone
 * fixes neither: the INSERT and its bookkeeping are separate operations, so the
 * lock cannot span them.
 *
 * So there is exactly one way to write this projection, and it is absolute. Both
 * writers take the conversation's row lock first, then recompute from the rows
 * that are committed at that moment. Every writer recomputes AFTER its own row
 * change has committed, so whichever acquires the lock last sees every change
 * and writes the truth. Any interleaving converges; none can leave the count
 * disagreeing with the transcript.
 *
 * It costs no more than it used to. The incremental version was a read followed
 * by an update — two round trips. This is a lock followed by one statement that
 * computes and writes together.
 */
const RECOMPUTE_SQL = (conversationId: string, tenantId: string | null) => Prisma.sql`
  WITH msgs AS (
    SELECT direction, "occurredAt", id
      FROM "Communication"
     WHERE "conversationId" = ${conversationId}
  ),
  first_inbound AS (
    SELECT min("occurredAt") AS at FROM msgs WHERE direction = 'inbound'
  ),
  agg AS (
    SELECT count(*)::int AS cnt,
           max("occurredAt") AS last_at,
           max("occurredAt") FILTER (WHERE direction = 'inbound') AS last_inbound_at
      FROM msgs
  ),
  newest AS (
    SELECT direction FROM msgs ORDER BY "occurredAt" DESC, id DESC LIMIT 1
  ),
  first_response AS (
    -- The same rule the incremental version applied one message at a time: the
    -- first outbound that happened once a customer message existed.
    SELECT min(m."occurredAt") AS at
      FROM msgs m, first_inbound f
     WHERE f.at IS NOT NULL AND m.direction = 'outbound' AND m."occurredAt" >= f.at
  )
  UPDATE "Conversation" c
     SET "messageCount"    = agg.cnt,
         -- An emptied conversation falls back to its own creation time rather
         -- than to now(): "last message at" must never be later than the last
         -- message.
         "lastMessageAt"   = COALESCE(agg.last_at, c."createdAt"),
         "lastDirection"   = (SELECT direction FROM newest),
         "lastInboundAt"   = agg.last_inbound_at,
         "firstResponseAt" = (SELECT at FROM first_response)
    FROM agg
   WHERE c.id = ${conversationId}
     AND (${tenantId}::text IS NULL OR c."tenantId" = ${tenantId})
`;

/**
 * Take the conversation's row lock, then recompute. Callers must already have
 * committed whatever row change they are reporting.
 */
async function lockAndRecompute(
  tx: Prisma.TransactionClient,
  conversationId: string,
  tenantId: string | null,
): Promise<void> {
  // The fence. Everything after this in the transaction takes a fresh snapshot,
  // so a writer that queued behind another sees that other's committed work.
  await tx.$executeRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} FOR UPDATE`;
  await tx.$executeRaw(RECOMPUTE_SQL(conversationId, tenantId));
}

/**
 * Recompute one conversation's derived state, on its own.
 *
 * `unread` is deliberately NOT derived. It means "nobody has opened the inbound
 * messages", it is cleared explicitly by `markConversationRead`, and deriving it
 * here would let a recompute silently mark a thread read — or silently unread a
 * thread somebody had just opened.
 */
export async function recomputeConversationDerivedState(conversationId: string): Promise<void> {
  const tenantId = conversationFilterTenantId();
  await basePrisma.$transaction(async (tx) => {
    await lockAndRecompute(tx, conversationId, tenantId);
  });
}

/**
 * Roll a conversation forward for a new message.
 *
 * Inbound messages additionally set `unread`, which is state rather than a
 * derivation — nothing about the messages themselves says whether a person has
 * looked at them — so it is written here and cleared only by
 * `markConversationRead`.
 */
export async function bumpConversation(
  conversationId: string,
  msg: { direction?: string | null; occurredAt?: Date }
): Promise<void> {
  const tenantId = conversationFilterTenantId();
  await basePrisma.$transaction(async (tx) => {
    await lockAndRecompute(tx, conversationId, tenantId);
    if (msg.direction === "inbound") {
      await tx.conversation.updateMany({
        where: { id: conversationId, ...(tenantId ? { tenantId } : {}) },
        data: { unread: true },
      });
    }
  });
}

/** Mark a conversation read (a staff member opened it). */
export async function markConversationRead(conversationId: string): Promise<void> {
  const tenantId = conversationFilterTenantId();
  await basePrisma.conversation.update({
    where: { id: conversationId, ...(tenantId ? { tenantId } : {}) },
    data: { unread: false },
  });
}

/**
 * Remove timeline rows AND put their conversations back to the state they would
 * have been in had those rows never existed.
 *
 * The reason this exists rather than a bare `deleteMany`. The guarded client
 * intercepts `Communication.create` to attach the row to a conversation and roll
 * that conversation's counters forward; nothing intercepts a delete. So removing
 * a row directly leaves the transcript correct and the projection one message
 * ahead for ever — and Conversation is what the inbox increasingly reads for
 * ordering, pagination and "who is waiting on us".
 *
 * Used by the Meta echo reconciliation, which deliberately records a possibly
 * duplicate row and removes it once the ledger proves the message was ours.
 * "Removes it" has to mean all of it.
 */
export async function deleteCommunicationsAndReconcile(
  where: { id?: string; dedupeKey?: string },
): Promise<number> {
  const doomed = await basePrisma.communication.findMany({
    where,
    select: { id: true, conversationId: true },
  });
  if (doomed.length === 0) return 0;

  const removed = await basePrisma.communication.deleteMany({
    where: { id: { in: doomed.map((row) => row.id) } },
  });
  // After the delete, so the recomputation sees the world without these rows.
  for (const conversationId of new Set(doomed.map((row) => row.conversationId).filter((id): id is string => Boolean(id)))) {
    await recomputeConversationDerivedState(conversationId);
  }
  return removed.count;
}
