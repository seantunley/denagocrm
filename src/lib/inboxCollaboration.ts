import "server-only";
import { basePrisma } from "./db";
import { threadCollaborationKey, type ThreadCollaboration, type ThreadIdentity } from "./inboxThreads";

/**
 * Joining the inbox's THREADS to the Conversation rows that carry collaboration.
 *
 * The inbox renders threads grouped from Communication rows (buildInboxThreads),
 * while assignment and notes live on Conversation. Both group the same way — one
 * per contact-or-lead per channel — so the two can be matched, but the thread's
 * identity is a composed string and the conversation's is a cuid, and nothing
 * connects them except this agreement.
 *
 * That agreement is the fragile part, so `threadCollaborationKey` exists to state
 * it once, and a test builds a real thread through buildInboxThreads and asserts
 * the keys match. If either side's grouping changes, that test fails rather than
 * the inbox quietly showing every thread as unassigned.
 */

/**
 * Load assignment and notes for the given threads, in one query per table.
 *
 * basePrisma: the caller has ALREADY scoped which threads exist (the inbox page
 * resolves accessibleInboxWhere before grouping), so these look up rows for
 * contacts and leads the user is established to be allowed. Going back through
 * the scoped client would re-filter on a tenant scope that is not yet stamped and
 * return nothing.
 */
export async function collaborationForThreads(
  threads: ThreadIdentity[],
): Promise<Map<string, ThreadCollaboration>> {
  const byKey = new Map<string, ThreadCollaboration>();
  if (threads.length === 0) return byKey;

  const contactIds = [...new Set(threads.map((t) => t.contactId).filter((id): id is string => Boolean(id)))];
  const leadIds = [...new Set(threads.map((t) => t.leadId).filter((id): id is string => Boolean(id)))];
  const channels = [...new Set(threads.map((t) => t.channel))];
  if (contactIds.length === 0 && leadIds.length === 0) return byKey;

  const conversations = await basePrisma.conversation.findMany({
    where: {
      channel: { in: channels },
      OR: [
        ...(contactIds.length ? [{ contactId: { in: contactIds } }] : []),
        ...(leadIds.length ? [{ leadId: { in: leadIds } }] : []),
      ],
    },
    select: {
      id: true,
      channel: true,
      contactId: true,
      leadId: true,
      lastMessageAt: true,
      assignedTo: { select: { id: true, name: true } },
    },
    // Newest first, so when a contact has both an open and a closed conversation
    // on one channel the live one is the one that wins the key below.
    orderBy: { lastMessageAt: "desc" },
  });
  if (conversations.length === 0) return byKey;

  const notes = await basePrisma.conversationNote.findMany({
    where: { conversationId: { in: conversations.map((c) => c.id) } },
    select: {
      id: true,
      conversationId: true,
      body: true,
      createdAt: true,
      author: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const notesByConversation = new Map<string, ThreadCollaboration["notes"]>();
  for (const note of notes) {
    const list = notesByConversation.get(note.conversationId) ?? [];
    list.push({ id: note.id, body: note.body, authorName: note.author.name, createdAt: note.createdAt });
    notesByConversation.set(note.conversationId, list);
  }

  const drafts = await basePrisma.conversationDraft.findMany({
    where: { conversationId: { in: conversations.map((c) => c.id) } },
    select: {
      conversationId: true,
      ownerId: true,
      body: true,
      updatedAt: true,
      owner: { select: { name: true } },
    },
  });
  const draftByConversation = new Map(
    drafts.map((draft) => [
      draft.conversationId,
      { ownerId: draft.ownerId, ownerName: draft.owner.name, body: draft.body, updatedAt: draft.updatedAt },
    ]),
  );

  for (const conversation of conversations) {
    const key = threadCollaborationKey(conversation);
    if (!key || byKey.has(key)) continue; // first (newest) wins
    byKey.set(key, {
      conversationId: conversation.id,
      assignee: conversation.assignedTo ?? null,
      notes: notesByConversation.get(conversation.id) ?? [],
      draft: draftByConversation.get(conversation.id) ?? null,
    });
  }
  return byKey;
}
