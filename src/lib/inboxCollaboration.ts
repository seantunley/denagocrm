import "server-only";
import { basePrisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { botIdentityForRecord } from "./botConversationControl";
import { conversationIdsForThreads } from "./inboxConversations";
import { type ThreadCollaboration, type ThreadIdentity } from "./inboxThreads";

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

  // Which Conversation each thread belongs to is decided ONCE, by the resolver the
  // reply path also depends on. Re-deriving it here by contact + channel is how the
  // panel and the send action came to disagree about which conversation a thread is.
  const idByKey = await conversationIdsForThreads(threads);
  if (idByKey.size === 0) return byKey;

  const conversations = await basePrisma.conversation.findMany({
    where: { id: { in: [...new Set(idByKey.values())] } },
    select: {
      id: true,
      tenantId: true,
      channel: true,
      contactId: true,
      leadId: true,
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
        select: { tenantId: true, channel: true, key: true, ownership: true },
      })
    : [];
  // `status: "paused"` alone cannot say WHO owns the thread. Since conversation
  // ownership landed it is written by BOTH a staff takeover (ownership 'human')
  // and the bot's own handoff (ownership 'ai_handoff'). Deriving the badge from
  // status therefore labelled a bot handoff "Human handling" — so staff left it
  // alone believing a colleague had it, while the customer sat waiting. That is
  // close to the opposite of the truth: a handoff is precisely the case that
  // needs a person to pick it up.
  const humanOwned = new Set(
    pausedSessions
      .filter((session) => session.ownership === "human")
      .map((session) => `${session.tenantId}:${session.channel}:${session.key}`),
  );
  const botByConversation = new Map(
    botTargets.map((target) => [
      target.conversationId,
      humanOwned.has(`${target.tenantId}:${target.channel}:${target.key}`) ? "human" as const : "bot" as const,
    ]),
  );
  const supportedConversations = new Set(botTargets.map((target) => target.conversationId));

  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  for (const [key, conversationId] of idByKey) {
    const conversation = byId.get(conversationId);
    if (!conversation) continue;
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
