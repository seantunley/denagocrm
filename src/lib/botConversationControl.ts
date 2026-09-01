import "server-only";
import { prisma } from "./db";
import { withStaffConversationScope } from "./actingScope";
import { withBotConversationWrite } from "./botTenant";
import { pauseBotSessionTx, releaseBotSessionTx } from "./botSessionStore";
import { HUMAN_RESPONSIBILITY_HOURS } from "./botOwnership";

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

/**
 * Pause automation because a person has taken responsibility for the thread.
 *
 * USER-ORIGINATED, and now CONVERTED — with its readers, not ahead of them. The
 * only caller is `setConversationMode` in `src/app/actions/conversations.ts`, a
 * Server Action, so a signed-in person is unambiguously doing this.
 *
 * #473 left it on `withTenantWrite` because a BotSession is keyed
 * `(tenantId, channel, key)` and the thing that READS this row is the flow runtime —
 * `botStillOwnsTx` in flowRun/flowSession, and `botMayStillSpeak` on the drain — all
 * of which resolved `writeTenantId() ?? DEFAULT`, i.e. the founding tenant while
 * dormant. Pausing under the acting workspace ALONE would have written a takeover
 * the runtime cannot see: the person presses Take over, the UI confirms it, and the
 * bot keeps answering over them on the next inbound message.
 *
 * Both sides now resolve one expression, {@link ../botTenant}.`botConversationTenantId`
 * — the ambient workspace, bound by `withChannelTenantScope` at the webhook and by
 * `withStaffConversationScope` here — so the pause and the ownership check cannot
 * land in different workspaces. `withStaffConversationScope` deliberately never
 * replaces a scope that is already bound, so this can only ever ADD the acting
 * workspace where nothing outranked it.
 */
export async function pauseBotConversation(
  identity: BotConversationIdentity,
  hours = HUMAN_RESPONSIBILITY_HOURS,
): Promise<void> {
  await withStaffConversationScope(() =>
    withBotConversationWrite(async (tx, tenantId) => {
      await pauseBotSessionTx(tx, tenantId, {
        channel: identity.channel,
        key: identity.key,
        // A PERSON owns this thread now. Nothing the customer types hands it back —
        // only resumeBotConversation below does. This is the distinction `paused`
        // could not make, and the reason "hi" used to evict the salesperson.
        ownership: "human",
        expiresAt: new Date(Date.now() + hours * 3600 * 1000),
      });
    }),
  );
}

/**
 * Return responsibility to automation. We deliberately clear the old session:
 * the NEXT customer message starts from the current published flow rather than
 * resuming halfway through a stale conversation the human may have changed.
 *
 * USER-ORIGINATED, and CONVERTED IN LOCKSTEP with {@link pauseBotConversation} —
 * see the reasoning there. Releasing under a different workspace from the one that
 * paused would leave the pause row orphaned and the conversation stuck with the bot
 * muted for a week, which is why these two can only ever move together.
 */
export async function resumeBotConversation(identity: BotConversationIdentity): Promise<void> {
  await withStaffConversationScope(() =>
    withBotConversationWrite(async (tx, tenantId) => {
      // The staff-release variant: a person is handing the thread back, so this is
      // the one path allowed to discard human ownership.
      await releaseBotSessionTx(tx, tenantId, identity.channel, identity.key);
    }),
  );
}
