import "server-only";
import { basePrisma } from "./db";
import { currentTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";

/**
 * The tenantId the top-level guard (db.ts `scopeArgs`) will stamp on the Communication
 * for the current scope. Conversation bookkeeping runs through `basePrisma` (to avoid
 * recursing back through the Communication create extension), which BYPASSES that
 * guard — so it must stamp the SAME owner itself. Otherwise the composite FK
 * `Communication(tenantId, conversationId) → Conversation(tenantId, id)` is violated,
 * and the conversation is an orphaned null-tenant row invisible under FORCE RLS.
 * Mirrors `scopeArgs` exactly: only enforcing + a non-system tenant scope stamps.
 */
function scopedConversationTenantId(): string | null {
  if (!tenantEnforcing()) return null;
  const scope = currentTenantScope();
  if (!scope || scope.system) return null;
  return scope.tenantId ?? null;
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
};

/**
 * Find the open conversation a new message belongs to (per contact/lead + channel),
 * creating one if none exists. Returns null for messages with no contact or lead.
 * Uses basePrisma so it never recurses through the Communication create extension.
 */
export async function resolveConversationId(data: MessageData): Promise<string | null> {
  if (!data.contactId && !data.leadId) return null;
  const channel = channelForType(data.type);
  const tenantId = scopedConversationTenantId();
  const subjectScope = data.contactId ? { contactId: data.contactId } : { leadId: data.leadId };
  const existing = await basePrisma.conversation.findFirst({
    // Reuse only the acting tenant's own open conversation when a tenant is in scope.
    where: { channel, status: { not: "closed" }, ...(tenantId ? { tenantId } : {}), ...subjectScope },
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
      tenantId,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Roll a conversation's counters forward for a new message. Inbound messages set
 * `unread` (cleared only when staff open the thread) and `lastInboundAt`; the first
 * outbound after an inbound records `firstResponseAt` (response-time foundation).
 */
export async function bumpConversation(
  conversationId: string,
  msg: { direction?: string | null; occurredAt?: Date }
): Promise<void> {
  const when = msg.occurredAt ?? new Date();
  const inbound = msg.direction === "inbound";
  const conv = await basePrisma.conversation.findUnique({
    where: { id: conversationId },
    select: { firstResponseAt: true, lastInboundAt: true },
  });
  const data: Record<string, unknown> = { lastMessageAt: when, messageCount: { increment: 1 } };
  // Kept current here, not only backfilled by the migration that added it: the
  // column answers "is a customer waiting on us?", and a value that stops
  // updating after deployment is worse than no column, because it reads as
  // current. Written on every message, including the outbound one that clears it.
  if (msg.direction) data.lastDirection = msg.direction;
  if (inbound) {
    data.unread = true;
    data.lastInboundAt = when;
  } else if (conv?.lastInboundAt && !conv.firstResponseAt) {
    data.firstResponseAt = when;
  }
  const tenantId = scopedConversationTenantId();
  await basePrisma.conversation.update({ where: { id: conversationId, ...(tenantId ? { tenantId } : {}) }, data });
}

/** Mark a conversation read (a staff member opened it). */
export async function markConversationRead(conversationId: string): Promise<void> {
  const tenantId = scopedConversationTenantId();
  await basePrisma.conversation.update({
    where: { id: conversationId, ...(tenantId ? { tenantId } : {}) },
    data: { unread: false },
  });
}

/**
 * Recompute a conversation's derived state from the messages that remain.
 *
 * `bumpConversation` rolls these forward INCREMENTALLY, one message at a time,
 * which is right on the way in and useless on the way out: an increment has no
 * inverse that can restore `lastMessageAt`, `lastDirection` or `firstResponseAt`
 * when the message that supplied them is removed. Decrementing the count alone
 * would leave a projection that is arithmetically tidy and factually wrong.
 *
 * So this recomputes rather than reverses, which also makes it idempotent —
 * running it twice, or on a conversation nothing was removed from, is a no-op.
 * It reads as few rows as it can: three aggregates and two lookups, never the
 * whole thread.
 *
 * `unread` is deliberately NOT recomputed. It means "nobody has opened the
 * inbound messages", it is cleared explicitly by `markConversationRead`, and the
 * only rows this is called for are OUTBOUND — which never set it. Deriving it
 * here would let a cleanup silently mark a thread read.
 */
export async function recomputeConversationDerivedState(conversationId: string): Promise<void> {
  const conversation = await basePrisma.conversation.findUnique({
    where: { id: conversationId },
    select: { createdAt: true },
  });
  if (!conversation) return;

  const [all, inbound] = await Promise.all([
    basePrisma.communication.aggregate({
      where: { conversationId },
      _count: { _all: true },
      _max: { occurredAt: true },
    }),
    basePrisma.communication.aggregate({
      where: { conversationId, direction: "inbound" },
      _min: { occurredAt: true },
      _max: { occurredAt: true },
    }),
  ]);

  const newest = await basePrisma.communication.findFirst({
    where: { conversationId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { direction: true },
  });

  // The same rule bumpConversation applies incrementally — the first outbound
  // that happened once a customer message existed — asked of the surviving rows
  // instead of remembered from the order they arrived in.
  const firstInboundAt = inbound._min.occurredAt;
  const firstResponse = firstInboundAt
    ? await basePrisma.communication.findFirst({
        where: { conversationId, direction: "outbound", occurredAt: { gte: firstInboundAt } },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        select: { occurredAt: true },
      })
    : null;

  const tenantId = scopedConversationTenantId();
  await basePrisma.conversation.update({
    where: { id: conversationId, ...(tenantId ? { tenantId } : {}) },
    data: {
      messageCount: all._count._all,
      // An emptied conversation falls back to its own creation time rather than
      // to now(): "last message at" must never be later than the last message.
      lastMessageAt: all._max.occurredAt ?? conversation.createdAt,
      lastDirection: newest?.direction ?? null,
      lastInboundAt: inbound._max.occurredAt ?? null,
      firstResponseAt: firstResponse?.occurredAt ?? null,
    },
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
