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
