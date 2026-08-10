import "server-only";
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
 */
async function conversationTenantId(data: MessageData): Promise<string> {
  if (typeof data.tenantId === "string" && data.tenantId) return data.tenantId;
  const subject = data.contactId
    ? await basePrisma.contact.findUnique({
        where: { id: data.contactId },
        select: { tenantId: true },
      })
    : data.leadId
      ? await basePrisma.lead.findUnique({ where: { id: data.leadId }, select: { tenantId: true } })
      : null;
  return inheritedTenantId(subject?.tenantId ?? null);
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
  const tenantId = conversationFilterTenantId();
  await basePrisma.conversation.update({ where: { id: conversationId, ...(tenantId ? { tenantId } : {}) }, data });
}

/** Mark a conversation read (a staff member opened it). */
export async function markConversationRead(conversationId: string): Promise<void> {
  const tenantId = conversationFilterTenantId();
  await basePrisma.conversation.update({
    where: { id: conversationId, ...(tenantId ? { tenantId } : {}) },
    data: { unread: false },
  });
}
