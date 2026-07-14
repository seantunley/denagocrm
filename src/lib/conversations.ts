import "server-only";
import { basePrisma } from "./db";

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
  const scope = data.contactId ? { contactId: data.contactId } : { leadId: data.leadId };
  const existing = await basePrisma.conversation.findFirst({
    where: { channel, status: { not: "closed" }, ...scope },
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
  await basePrisma.conversation.update({ where: { id: conversationId }, data });
}

/** Mark a conversation read (a staff member opened it). */
export async function markConversationRead(conversationId: string): Promise<void> {
  await basePrisma.conversation.update({
    where: { id: conversationId },
    data: { unread: false },
  });
}
