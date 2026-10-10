import { z } from "zod";
import { prisma } from "@/lib/db";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { reqMeta, logSignEvent } from "@/lib/signing/events";
import { isRequestClosed } from "@/lib/signing/status";
import { loadRecipientIdentity, identityStatus } from "@/lib/signing/identity";
import { deliverSignerQuestion } from "@/lib/signing/question";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { throttlePublic } from "@/lib/publicThrottle";
import { PUBLIC_ACTION_POLICY } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Written before anything is delivered, so it is also what the limits below count. */
const QUESTION_EVENT = "question_asked";
const COOLDOWN_MS = 60 * 1000;
/** Per signer, per document. Past this it is a conversation, and a form is the wrong place for one. */
const MAX_QUESTIONS = 5;

const bodySchema = z.object({ question: z.string().trim().min(3).max(1000) }).strict();

/**
 * "I have a question", from the signing page.
 *
 * The question is filed under the customer's name, on their record, in front of
 * the people they are dealing with — so it is accepted only from someone who
 * could sign: a live link, an open request, past the identity check when the
 * document asks for one, and whose turn it is. It signs nothing, declines
 * nothing and changes nothing about the request.
 *
 * Its own throttle scope, so asking cannot use up the attempts signing needs.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await throttlePublic("signing-question", token, PUBLIC_ACTION_POLICY);
  if (throttled) return throttled;
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    () => handleQuestion(token, req),
    () => new Response("Not found", { status: 404 }),
  );
}

async function handleQuestion(token: string, req: Request): Promise<Response> {
  const [recipient, identity] = await Promise.all([
    prisma.signatureRecipient.findUnique({
      where: { token: hashSignToken(token) },
      include: { request: { include: { recipients: { select: { order: true, role: true, status: true } } } } },
    }),
    loadRecipientIdentity(token),
  ]);
  if (!recipient || !identity || !recipient.tenantId) return new Response("Not found", { status: 404 });
  const request = recipient.request;

  if (request.deletedAt || isRequestClosed(request.status) || (request.expiresAt && request.expiresAt < new Date())) {
    return new Response("This document is no longer open. Please contact the sender directly.", { status: 409 });
  }
  const assurance = identityStatus(identity);
  if (assurance.required && !assurance.verified) {
    return new Response("Verify your identity before sending a question.", { status: 403 });
  }
  if (recipient.role === "viewer" || recipient.status === "signed" || recipient.status === "declined") {
    return new Response("This link can no longer be used to send a question. Please contact the sender directly.", { status: 403 });
  }
  if (
    request.ordering === "sequential" &&
    request.recipients.some((other) => other.order < recipient.order && other.role !== "viewer" && other.status !== "signed")
  ) {
    return new Response("It's not your turn to sign yet.", { status: 409 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("Please type your question (up to 1,000 characters).", { status: 400 });
  const question = parsed.data.question;

  const earlier = await prisma.signatureEvent.findMany({
    where: { requestId: request.id, recipientId: recipient.id, type: QUESTION_EVENT },
    orderBy: { createdAt: "desc" },
    take: MAX_QUESTIONS,
    select: { createdAt: true },
  });
  if (earlier.length >= MAX_QUESTIONS) {
    return new Response("You have sent several questions already. Please contact the sender directly.", { status: 429 });
  }
  if (earlier[0] && Date.now() - earlier[0].createdAt.getTime() < COOLDOWN_MS) {
    return new Response("Your last question was sent a moment ago. Please wait a minute before sending another.", { status: 429 });
  }

  // On the document's own record first: whatever happens to the alerts below,
  // the trail shows the signer asked, and what.
  const meta = await reqMeta();
  await logSignEvent(request.id, {
    type: QUESTION_EVENT,
    recipientId: recipient.id,
    actor: recipient.name,
    channel: "web",
    ip: meta.ip,
    userAgent: meta.ua,
    metadata: { question },
  });

  const reached = await deliverSignerQuestion({
    request,
    signer: { name: recipient.name, email: recipient.email },
    question,
  });
  if (!reached) {
    return new Response("We could not pass your question on just now. Please contact the sender directly.", { status: 502 });
  }
  return Response.json({ ok: true });
}
