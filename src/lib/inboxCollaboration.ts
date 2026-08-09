import "server-only";
import { basePrisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { botIdentityForRecord } from "./botConversationControl";
import { threadCollaborationKey, type ThreadCollaboration, type ThreadIdentity } from "./inboxThreads";

/**
 * Joining the inbox's THREADS to the Conversation rows that carry collaboration.
 * Both the inbox and the chatbot ownership controls address the same underlying
 * contact-or-lead + channel conversation; this loader makes that relationship
 * explicit instead of asking the browser to rediscover it with one request per row.
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
      tenantId: true,
      channel: true,
      contactId: true,
      leadId: true,
      lastMessageAt: true,
      assignedTo: { select: { id: true, name: true } },
      contact: {
        select: {
          whatsapp: true,
          phone: true,
          messengerPsid: true,
          instagramId: true,
        },
      },
      lead: { select: { phone: true } },
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

  const botTargets = conversations.flatMap((conversation) => {
    const identity = botIdentityForRecord(conversation);
    return identity
      ? [{
          conversationId: conversation.id,
          tenantId: conversation.tenantId ?? DEFAULT_TENANT_ID,
          ...identity,
        }]
      : [];
  });
  const pausedSessions = botTargets.length
    ? await basePrisma.botSession.findMany({
        where: {
          status: "paused",
          expiresAt: { gt: new Date() },
          OR: botTargets.map((target) => ({
            tenantId: target.tenantId,
            channel: target.channel,
            key: target.key,
          })),
        },
        select: { tenantId: true, channel: true, key: true },
      })
    : [];
  const paused = new Set(pausedSessions.map((session) => `${session.tenantId}:${session.channel}:${session.key}`));
  const botByConversation = new Map(
    botTargets.map((target) => [
      target.conversationId,
      paused.has(`${target.tenantId}:${target.channel}:${target.key}`) ? "human" as const : "bot" as const,
    ]),
  );
  const supportedConversations = new Set(botTargets.map((target) => target.conversationId));

  for (const conversation of conversations) {
    const key = threadCollaborationKey(conversation);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, {
      conversationId: conversation.id,
      assignee: conversation.assignedTo ?? null,
      notes: notesByConversation.get(conversation.id) ?? [],
      bot: {
        supported: supportedConversations.has(conversation.id),
        mode: botByConversation.get(conversation.id) ?? "bot",
      },
      draft: draftByConversation.get(conversation.id) ?? null,
    });
  }
  return byKey;
}
