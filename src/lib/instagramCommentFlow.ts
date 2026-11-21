import "server-only";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { logError } from "./errorLog";
import { resolveTenantActor } from "./tenantActor";
import { getCompanyProfile } from "./companyProfile";
import { runtimeFlowTenantId } from "./flowScope";
import { routeMatches, type FlowEntryContext } from "./flowRouteRule";
import { advanceFlow, greetingVars } from "./flowSession";
import { dmFlowCtx } from "./flowDm";
import { outMsgText } from "./flowMedia";
import type { OutMsg } from "./flow";
import { sendPrivateReplyToComment } from "./messenger";
import { commentDedupeKey, isOwnPageComment, privateReplyDedupeKey, type IngestibleComment } from "./socialComments";
import { isDedupeKeyConflict } from "./inboundMessageKey";
import { commentFlowReplyKey } from "./instagramComments";
import { deleteCommunicationsAndReconcile } from "./conversations";

/**
 * A COMMENT STARTS A FLOW (Instagram follow gate, part 3; Sean, 2026-11-21: comment → follows us → the guide).
 *
 * Only when a comment matches an enabled Instagram "Comment keyword" route — never the channel's default flow, so an
 * ordinary comment is just filed in the inbox. The flow runs as the commenter's DM conversation (keyed by their
 * Instagram id, as their DMs are), and its first turn goes out as the comment's ONE private reply, plain text (Meta's
 * rule: one DM per comment, within 7 days). Their answer arrives as an ordinary DM and the same conversation carries
 * on — the follow check, the guide.
 *
 * The private reply is RESERVED before anything is sent — once per person per post (commentFlowReplyKey), and never
 * where a staff member already replied privately to the comment (the inbox's own key, actions/comments.ts): a
 * redelivered comment, a repeated comment or a race can never send a second. Refused by Meta: the reservation is released and the failure is in the System Log. No answer at all:
 * the reservation stays (it may have been delivered).
 */
export async function runInstagramCommentFlow(igAccountId: string, comment: IngestibleComment): Promise<void> {
  const commenter = comment.authorId;
  if (!commenter || isOwnPageComment(comment, igAccountId)) return;
  if ((await getSetting("BOT_ENABLED")) !== "true" || (await getSetting("BOT_DM_ENABLED")) !== "true") return;
  const tenantId = runtimeFlowTenantId();

  // Only a Comment keyword route — and the entry carries the comment ONLY, so no DM keyword route can match it.
  const entry: FlowEntryContext = { text: "", commentText: comment.message };
  const routes = await prisma.botFlowRoute.findMany({
    where: { tenantId, channel: "instagram", enabled: true, kind: "comment" },
    select: { kind: true, pattern: true },
  });
  if (!routes.some((route) => routeMatches(route, entry))) return;

  // The comment's thread (a muted post's comments aren't filed, so they start nothing).
  const filed = await prisma.communication.findFirst({
    where: { tenantId, dedupeKey: commentDedupeKey(tenantId, comment.commentId) },
    select: { conversationId: true },
  });
  const actor = await resolveTenantActor();
  if (!filed?.conversationId || !actor) return;

  // A person already replied privately to this comment from the inbox: theirs is the one Meta allows.
  if (await prisma.communication.findFirst({ where: { tenantId, dedupeKey: privateReplyDedupeKey(tenantId, comment.commentId) }, select: { id: true } })) return;
  // ONCE PER PERSON PER POST (Sean, 2026-11-21): the reservation's unique key is this person on this post, so a second
  // or third "GUIDE" — or a redelivery of the first — finds it taken and gets nothing more, even at the same moment.
  // `inReplyTo` names the comment answered, so the inbox stops offering a reply Meta would refuse.
  const replyKey = commentFlowReplyKey(tenantId, comment.postId, commenter);
  try {
    await prisma.communication.create({
      data: {
        type: "comment", direction: "outbound", body: "…", subject: "Private reply (chatbot)",
        conversationId: filed.conversationId, inReplyTo: comment.commentId, dedupeKey: replyKey, userId: actor.id, tenantId,
      },
    });
  } catch (error) {
    if (isDedupeKeyConflict(error)) return; // already answered — a redelivery, or a person got there first
    throw error;
  }

  // The flow's first turn, for this person, from its start — its messages become the private reply.
  const firstTurn: OutMsg[] = [];
  const result = await advanceFlow(
    "instagram",
    commenter,
    { text: comment.message },
    dmFlowCtx("instagram", commenter, null),
    greetingVars(null, (await getCompanyProfile()).name),
    async (messages) => { firstTurn.push(...messages); },
    entry,
  );
  // One private reply, text only: the turn's messages as one message.
  const text = firstTurn.map(outMsgText).filter(Boolean).join("\n\n").slice(0, 1000);
  if (result.suppressed || !text) {
    await deleteCommunicationsAndReconcile({ dedupeKey: replyKey });
    return;
  }

  let sent: Awaited<ReturnType<typeof sendPrivateReplyToComment>>;
  try {
    sent = await sendPrivateReplyToComment(comment.commentId, text);
  } catch {
    // No answer from Meta: it may have been delivered, so the reservation stays and nothing is sent again.
    await prisma.communication.updateMany({ where: { dedupeKey: replyKey }, data: { body: text } });
    return;
  }
  if (!sent.ok) {
    await deleteCommunicationsAndReconcile({ dedupeKey: replyKey });
    // Meta's reason only — never the person or their comment.
    await logError("instagram-comment-flow", sent.error ?? "Meta refused the private reply", "The comment's flow could not send its private reply.").catch(() => {});
    return;
  }
  await prisma.communication.updateMany({ where: { dedupeKey: replyKey }, data: { body: text, messageId: sent.providerMessageId } });
}
