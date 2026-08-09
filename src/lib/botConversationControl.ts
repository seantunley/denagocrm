import "server-only";
import { prisma } from "./db";
import { withTenantWrite } from "./tenantWrite";
import { deleteBotSessionTx, pauseBotSessionTx } from "./botSessionStore";

export type BotOwnedChannel = "whatsapp" | "messenger" | "instagram";
export type BotConversationIdentity = { channel: BotOwnedChannel; key: string };

type ConversationIdentityRecord = {
  channel: string;
  contact?: {
    whatsapp?: string | null;
    phone?: string | null;
    messengerPsid?: string | null;
    instagramId?: string | null;
  } | null;
  lead?: { phone?: string | null } | null;
};

function whatsappKey(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `27${digits.slice(1)}`;
  return digits || null;
}

/**
 * The inbox and webhook runtimes must address the SAME BotSession participant.
 * Keep that mapping in one pure helper so takeover controls cannot pause one key
 * while the channel adapter continues on another.
 */
export function botIdentityForRecord(record: ConversationIdentityRecord): BotConversationIdentity | null {
  if (record.channel === "whatsapp") {
    const key = whatsappKey(record.contact?.whatsapp ?? record.contact?.phone ?? record.lead?.phone);
    return key ? { channel: "whatsapp", key } : null;
  }
  if (record.channel === "messenger") {
    const key = record.contact?.messengerPsid?.trim();
    return key ? { channel: "messenger", key } : null;
  }
  if (record.channel === "instagram") {
    const key = record.contact?.instagramId?.trim();
    return key ? { channel: "instagram", key } : null;
  }
  return null;
}

export async function botIdentityForConversation(conversationId: string): Promise<BotConversationIdentity | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      channel: true,
      contact: { select: { whatsapp: true, phone: true, messengerPsid: true, instagramId: true } },
      lead: { select: { phone: true } },
    },
  });
  return conversation ? botIdentityForRecord(conversation) : null;
}

/** Pause automation because a person has taken responsibility for the thread. */
export async function pauseBotConversation(
  identity: BotConversationIdentity,
  hours = 7 * 24,
): Promise<void> {
  await withTenantWrite(async (tx, tenantId) => {
    await pauseBotSessionTx(tx, tenantId, {
      channel: identity.channel,
      key: identity.key,
      expiresAt: new Date(Date.now() + hours * 3600 * 1000),
    });
  });
}

/**
 * Return responsibility to automation. We deliberately clear the old session:
 * the NEXT customer message starts from the current published flow rather than
 * resuming halfway through a stale conversation the human may have changed.
 */
export async function resumeBotConversation(identity: BotConversationIdentity): Promise<void> {
  await withTenantWrite(async (tx, tenantId) => {
    await deleteBotSessionTx(tx, tenantId, identity.channel, identity.key);
  });
}
