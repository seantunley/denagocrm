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
import { withBotConversationWrite } from "./botTenant";
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

  // ONE PRIVATE REPLY PER COMMENT — THE SAME LOCK AS STAFF (review of #1179): the reservation IS the inbox's own
  // per-comment key (privateReplyDedupeKey, actions/comments.ts), so the chatbot and a person pressing Reply privately
  // can never both send, in either order. ONCE PER PERSON PER POST (Sean, 2026-11-21): a marker keyed on this person
  // and this post, written in the SAME transaction — a second "GUIDE", a redelivery or a race finds one of the two taken
  // and reserves nothing. Subject "Private reply", so the inbox shows the reply as spent.
  const replyKey = privateReplyDedupeKey(tenantId, comment.commentId);
  const personKey = commentFlowReplyKey(tenantId, comment.postId, commenter);
  const reserved = await prisma
    .$transaction(async (tx) => {
      await tx.appSetting.create({ data: { tenantId, key: personKey, value: comment.commentId } });
      await tx.communication.create({
        data: {
          type: "comment", direction: "outbound", body: "…", subject: "Private reply",
          conversationId: filed.conversationId, inReplyTo: comment.commentId, dedupeKey: replyKey, userId: actor.id, tenantId,
        },
      });
      return true;
    })
    .catch((error: unknown) => {
      if ((error as { code?: string } | null)?.code === "P2002") return false; // already answered — by us or a person
      throw error;
    });
  if (!reserved) return;
  const release = async () => {
    await deleteCommunicationsAndReconcile({ dedupeKey: replyKey });
    await prisma.appSetting.deleteMany({ where: { tenantId, key: personKey } });
  };
  // A refused first reply means the flow never asked them anything: its session goes too (a person-owned one stays).
  // FENCED TO THIS TURN (review of #1179): only the session exactly as this comment's turn left it — same row, same
  // updatedAt (every session write stamps it). A DM turn or a staff handoff that moved it on since is never discarded.
  let turnSession: { id: string; updatedAt: Date } | null = null;
  const forgetSession = () =>
    withBotConversationWrite(async (tx, owner) => {
      if (!turnSession) return;
      await tx.botSession.deleteMany({ where: { id: turnSession.id, tenantId: owner, ownership: { not: "human" }, updatedAt: turnSession.updatedAt } });
    });

  // The flow's first turn, for this person, from its start — its messages become the private reply.
  const firstTurn: OutMsg[] = [];
  let result: Awaited<ReturnType<typeof advanceFlow>>;
  try {
    result = await advanceFlow(
      "instagram",
      commenter,
      { text: comment.message },
      dmFlowCtx("instagram", commenter, null),
      greetingVars(null, (await getCompanyProfile()).name),
      async (messages) => { firstTurn.push(...messages); },
      entry,
    );
  } catch (error) {
    // Nothing was sent: the reservation is released so a redelivery can try again.
    await release();
    throw error;
  }
  turnSession = await prisma.botSession.findFirst({ where: { tenantId, channel: "instagram", key: commenter }, select: { id: true, updatedAt: true } });
  // One private reply, text only: the turn's messages as one message.
  const text = firstTurn.map(outMsgText).filter(Boolean).join("\n\n").slice(0, 1000);
  if (result.suppressed || !text) {
    await release();
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
    // A definite refusal: nothing reached them, so neither the reservation nor the flow's "asked" state stands.
    await release();
    await forgetSession();
    // Meta's reason only — never the person or their comment.
    await logError("instagram-comment-flow", sent.error ?? "Meta refused the private reply", "The comment's flow could not send its private reply.").catch(() => {});
    return;
  }
  await prisma.communication.updateMany({ where: { dedupeKey: replyKey }, data: { body: text, messageId: sent.providerMessageId } });
}
