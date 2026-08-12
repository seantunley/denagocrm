import "server-only";
import { basePrisma } from "./db";
import { resolveConversationId } from "./conversations";
import { threadCollaborationKey, type ThreadIdentity } from "./inboxThreads";

/**
 * The canonical Conversation id behind each inbox thread.
 *
 * The inbox groups Communication rows into threads by contact-or-lead + channel.
 * That grouping is a view; the Conversation is the RECORD. For Messenger and
 * Instagram the difference is load-bearing: `sendDmReply` decides which platform
 * to deliver on by reading the Conversation's channel, because the alternative —
 * believing a channel the browser posted — lets anyone with inbox.reply choose
 * Messenger or Instagram for a customer who has both identities. So the reply box
 * cannot be enabled for a DM thread until this resolves an id for it.
 */

/**
 * Channels whose reply path cannot proceed without a Conversation, so a thread
 * missing one has it created rather than being left unanswerable.
 *
 * WhatsApp is absent deliberately. Its reply path addresses a phone number that
 * the server re-reads from the contact, so nothing about delivery depends on the
 * Conversation, and creating rows on sight for threads that never needed one
 * would be a write with no reader.
 */
const CHANNELS_REQUIRING_CONVERSATION = new Set(["messenger", "instagram"]);

/**
 * Map inbox threads to their Conversation ids, creating the missing DM ones.
 *
 * Keyed by `threadCollaborationKey`, the same key the collaboration loader uses,
 * so the two maps address the same threads. When a contact has more than one
 * conversation on a channel the newest wins — matching `resolveConversationId`,
 * which is what every inbound message has been attaching itself to.
 */
export async function conversationIdsForThreads(
  threads: ThreadIdentity[],
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  if (threads.length === 0) return byKey;

  const contactIds = [...new Set(threads.map((t) => t.contactId).filter((id): id is string => Boolean(id)))];
  const leadIds = [...new Set(threads.map((t) => t.leadId).filter((id): id is string => Boolean(id)))];
  const channels = [...new Set(threads.map((t) => t.channel))];
  if (contactIds.length === 0 && leadIds.length === 0) return byKey;

  // basePrisma, and no tenant predicate of its own, for the reason the
  // collaboration loader states: the contact and lead ids come from threads the
  // caller has already scoped, so this join inherits their scoping rather than
  // asking about conversations of its own. Creation stamps the acting tenant —
  // `resolveConversationId` mirrors the guard's own rule.
  const existing = await basePrisma.conversation.findMany({
    where: {
      channel: { in: channels },
      OR: [
        ...(contactIds.length ? [{ contactId: { in: contactIds } }] : []),
        ...(leadIds.length ? [{ leadId: { in: leadIds } }] : []),
      ],
    },
    select: { id: true, channel: true, contactId: true, leadId: true },
    // Newest first, so when a contact has both a live and a closed conversation
    // on one channel the live one is the one that wins the key below.
    orderBy: { lastMessageAt: "desc" },
  });
  for (const conversation of existing) {
    const key = threadCollaborationKey(conversation);
    if (key && !byKey.has(key)) byKey.set(key, conversation.id);
  }

  // Only the threads that still have none, and only on the channels that need
  // one. Sequential rather than parallel: this is the rare legacy path — every
  // Communication written since conversations landed resolves one on create —
  // and a burst of concurrent find-or-create on the same contact is exactly how
  // duplicates appear.
  for (const thread of threads) {
    const key = threadCollaborationKey(thread);
    if (!key || byKey.has(key)) continue;
    if (!CHANNELS_REQUIRING_CONVERSATION.has(thread.channel)) continue;
    // Only the id here: this maps threads to conversations for the reply box, and
    // writes no row that has to match the thread's owner.
    const conversation = await resolveConversationId({
      contactId: thread.contactId,
      leadId: thread.leadId,
      type: thread.channel,
    });
    if (conversation) byKey.set(key, conversation.id);
  }
  return byKey;
}
