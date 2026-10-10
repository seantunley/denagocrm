import { z } from "zod";
import { prisma } from "@/lib/db";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { reqMeta, buildSignEvent } from "@/lib/signing/events";
import { isRequestClosed } from "@/lib/signing/status";
import { loadRecipientIdentity, identityStatus } from "@/lib/signing/identity";
import { verifyInPersonPass } from "@/lib/signing/inPerson";
import { notifyCreatorDeclined } from "@/lib/signing/notify";
import { isCustomerSigner } from "@/lib/signing/quoteMirror";
import { logAudit } from "@/lib/audit";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { rateLimitSigning } from "@/lib/signing/throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reason: z.string().trim().max(2000).default(""),
  // A staff member's in-person pass (lib/signing/inPerson.ts), when the signer
  // is declining on that member of staff's device.
  inPerson: z.string().min(1).max(1200).optional(),
}).strict();

class DeclineAbort extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await rateLimitSigning(token);
  if (throttled) return throttled;
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    () => handleDecline(token, req),
    () => new Response("Not found", { status: 404 }),
  );
}

async function handleDecline(token: string, req: Request): Promise<Response> {
  const [recipient, identity] = await Promise.all([
    prisma.signatureRecipient.findUnique({ where: { token: hashSignToken(token) }, include: { request: true } }),
    loadRecipientIdentity(token),
  ]);
  if (!recipient || !identity || !recipient.tenantId) return new Response("Not found", { status: 404 });
  const tenantId = recipient.tenantId;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return new Response("Invalid request", { status: 400 });
  const reason = parsed.data.reason;

  // Declining on a member of staff's device, in front of them — the same pass
  // the sign route honours, refused the same way when it does not verify.
  const witness = parsed.data.inPerson
    ? verifyInPersonPass(parsed.data.inPerson, recipient.id, tenantId)
    : null;
  if (parsed.data.inPerson && !witness) {
    return new Response("This in-person signing session has expired. Ask the staff member to open it again.", { status: 403 });
  }

  const assurance = identityStatus(identity);
  if (assurance.required && !assurance.verified && !witness) {
    return new Response("Verify your identity before declining.", { status: 403 });
  }
  if (recipient.status === "signed") return new Response("Already signed", { status: 409 });
  if (recipient.status === "declined") return new Response("Already declined", { status: 409 });
  if (recipient.request.deletedAt || isRequestClosed(recipient.request.status)) return new Response("Closed", { status: 409 });
  if (recipient.request.expiresAt && recipient.request.expiresAt < new Date()) {
    return new Response("This signing link has expired.", { status: 409 });
  }

  const meta = await reqMeta();
  const decidedAt = new Date();
  // A customer turning the quote down is the quote being declined (Sean,
  // 2026-10-09). A member of staff declining their own countersignature is not
  // the customer's answer, so it leaves the quote alone — the same test that
  // decides whose opening counts as "the customer viewed it".
  const quoteId = recipient.request.quoteId;
  const declinesQuote = quoteId ? await isCustomerSigner(recipient, tenantId) : false;
  let quoteDeclined = false;

  try {
    await prisma.$transaction(async (tx) => {
      // Universal lock order — SOURCE record first, THEN the request — the one
      // completion, voiding and signing start already keep, so a decline that
      // now writes the quote cannot deadlock against any of them.
      if (quoteId) {
        await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      }
      const rows = await tx.$queryRaw<Array<{
        status: string;
        deletedAt: Date | null;
        expiresAt: Date | null;
        identityMode: string;
      }>>`
        SELECT "status", "deletedAt", "expiresAt", "identityMode"
        FROM "SignatureRequest"
        WHERE "id" = ${recipient.requestId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      const request = rows[0];
      if (!request || request.deletedAt || isRequestClosed(request.status)) {
        throw new DeclineAbort(409, "Closed");
      }
      if (request.expiresAt && request.expiresAt < decidedAt) {
        throw new DeclineAbort(409, "This signing link has expired.");
      }

      const locked = await tx.$queryRaw<Array<{ status: string; identityVerifiedAt: Date | null }>>`
        SELECT "status", "identityVerifiedAt"
        FROM "SignatureRecipient"
        WHERE "id" = ${recipient.id}
          AND "requestId" = ${recipient.requestId}
          AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      if (!locked[0] || ["signed", "declined"].includes(locked[0].status)) {
        throw new DeclineAbort(409, "Already actioned");
      }
      if (request.identityMode !== "link" && !locked[0].identityVerifiedAt && !witness) {
        throw new DeclineAbort(403, "Verify your identity before declining.");
      }

      const claimed = await tx.signatureRecipient.updateMany({
        where: {
          id: recipient.id,
          tenantId,
          status: { notIn: ["signed", "declined"] },
        },
        data: { status: "declined", declinedAt: decidedAt, declineReason: reason || null },
      });
      if (claimed.count === 0) throw new DeclineAbort(409, "Already actioned");

      const closed = await tx.signatureRequest.updateMany({
        where: {
          id: recipient.requestId,
          tenantId,
          status: { notIn: ["completed", "declined", "expired", "voided", "rejected"] },
        },
        data: { status: "declined", declinedAt: decidedAt },
      });
      if (closed.count !== 1) throw new DeclineAbort(409, "Closed");

      if (quoteId && declinesQuote) {
        // Only a quote still on offer. Accepted, cancelled, replaced or trashed
        // ones keep the state somebody deliberately gave them.
        const declined = await tx.quote.updateMany({
          where: {
            id: quoteId,
            tenantId,
            deletedAt: null,
            signedAt: null,
            supersededAt: null,
            status: { in: ["draft", "sent"] },
          },
          data: { status: "declined", declinedAt: decidedAt, declineReason: reason || null },
        });
        quoteDeclined = declined.count === 1;
      }

      await tx.signatureEvent.create({
        data: buildSignEvent(recipient.requestId, {
          recipientId: recipient.id,
          type: "declined",
          actor: recipient.name,
          channel: witness ? "in_person" : "web",
          ip: meta.ip,
          userAgent: meta.ua,
          metadata: {
            reason,
            identityMode: request.identityMode,
            ...(witness ? { witness: { userId: witness.userId, name: witness.name } } : {}),
          },
        }),
      });
      // Recipient and request triggers enqueue notification recovery and revoke
      // every bearer link in this same commit.
    });
  } catch (error) {
    if (error instanceof DeclineAbort) return new Response(error.message, { status: error.status });
    throw error;
  }

  // Best-effort latency path; the transition outbox retries until the immutable
  // decline_notification_sent marker exists.
  await notifyCreatorDeclined(recipient.requestId, recipient.name, reason).catch(() => ({ ok: false }));
  if (quoteId && quoteDeclined) await afterQuoteDeclined(quoteId, recipient.name, reason);
  return Response.json({ ok: true });
}

/**
 * What a staff member declining the quote by hand also does (actions/quotes.ts):
 * the timeline entry, and the "Quote is declined" journey trigger. The decline
 * itself is already committed, so neither may fail it.
 */
async function afterQuoteDeclined(quoteId: string, who: string, reason: string): Promise<void> {
  const quote = await prisma.quote
    .findUnique({ where: { id: quoteId }, select: { number: true, leadId: true, contactId: true, updatedAt: true } })
    .catch(() => null);
  if (!quote) return;
  await logAudit({
    action: "quote.declined",
    summary: `Quote Q-${quote.number} declined by ${who} on the signing page${reason ? ` — “${reason.slice(0, 200)}”` : ""}`,
    leadId: quote.leadId,
    contactId: quote.contactId,
    userName: who,
  }).catch(() => {});
  if (quote.leadId) {
    // Keyed on the quote, as the manual decline is: declining does not touch the
    // lead row, and a quote can be declined, re-sent and declined again.
    await emitLeadJourneyEvent("quote_declined", quote.leadId, {
      occurrence: `quote:${quoteId}:declined:${quote.updatedAt.toISOString()}`,
      payload: { quoteId, quoteNumber: quote.number },
    });
  }
}
