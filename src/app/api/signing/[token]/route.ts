import { z } from "zod";
import { prisma } from "@/lib/db";
import { saveFile, deleteFile } from "@/lib/storage";
import { isValidSignToken } from "@/lib/signing/tokens";
import { logSignEvent, reqMeta } from "@/lib/signing/events";
import { advanceAfterSignature } from "@/lib/signing/workflow";
import { isRequestClosed } from "@/lib/signing/status";
import { missingRequiredForRecipient } from "@/lib/signing/fieldValidation";
import { logAudit } from "@/lib/audit";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { rateLimitSigning } from "@/lib/signing/throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Thrown inside the sign transaction to abort with a specific HTTP status. */
class SignAbort extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const bodySchema = z.object({
  name: z.string().min(2).max(120),
  consent: z.literal(true),
  fields: z.array(z.object({ id: z.string(), value: z.string().max(800000) })).default([]),
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  // Throttle before ANY database work. Keyed on both the token and the caller's
  // IP: the token bounds abuse of one link, the IP bounds someone walking
  // well-formed tokens. See SIGNING_POLICY — a real signer never reaches it.
  const throttled = await rateLimitSigning(token);
  if (throttled) return throttled;
  // Phase C no-user edge: this public token route carries no staff session. Derive
  // the document's tenant from a narrow trusted lookup FIRST, then run the whole
  // guarded operation inside that scope — a guarded read before the scope exists
  // would dead-lock under enforcement. Dormant no-op when off; fails closed (404)
  // under enforcement for an unknown / untenanted token.
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    () => handleSign(token, req),
    () => new Response("Not found", { status: 404 }),
  );
}

async function handleSign(token: string, req: Request): Promise<Response> {
  const recipient = await prisma.signatureRecipient.findUnique({ where: { token }, include: { request: true } });
  if (!recipient) return new Response("Not found", { status: 404 });
  const request = recipient.request;
  // The signing PAGE enforced these; the API must repeat every one — a direct
  // POST bypasses the page entirely.
  if (request.deletedAt || isRequestClosed(request.status)) {
    return new Response("This document can no longer be signed.", { status: 409 });
  }
  if (request.expiresAt && request.expiresAt < new Date()) {
    return new Response("This signing link has expired.", { status: 409 });
  }
  if (recipient.status === "signed") return new Response("Already signed", { status: 409 });
  if (recipient.status === "declined") return new Response("You have declined this document.", { status: 409 });
  if (recipient.role === "viewer") return new Response("View only", { status: 403 });

  // Sequential workflows: block a later signer until every earlier, non-viewer
  // recipient has signed (the page's "Not your turn yet" rule).
  if (request.ordering === "sequential") {
    const earlier = await prisma.signatureRecipient.findFirst({
      where: { requestId: request.id, role: { not: "viewer" }, order: { lt: recipient.order }, status: { not: "signed" } },
      select: { id: true },
    });
    if (earlier) return new Response("It's not your turn to sign yet.", { status: 409 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("Invalid submission", { status: 400 });
  const { name, fields } = parsed.data;
  const meta = await reqMeta();

  const requestFields = await prisma.signatureField.findMany({ where: { requestId: request.id } });
  const fillable = new Map(requestFields.filter((f) => f.recipientId === recipient.id || f.recipientId === null).map((f) => [f.id, f]));

  // Required-field validation PER RECIPIENT. Every required fillable field must
  // arrive with a complete, kind-aware value in THIS submission (checkbox = must
  // be "true", not the string "false"), or already have this recipient's own
  // durable response. We must NOT accept a globally-filled SignatureField as
  // satisfied: on a SHARED field the first signer's value cannot let a later
  // signer skip their own acknowledgement — that's the point of one response per
  // recipient. The page enforces this client-side; the API repeats it.
  const submittedValue = new Map(fields.map((f) => [f.id, f.value]));
  const priorResponseFieldIds = new Set(
    (
      await prisma.signatureFieldResponse.findMany({
        where: { recipientId: recipient.id, field: { requestId: request.id } },
        select: { fieldId: true },
      })
    ).map((r) => r.fieldId),
  );
  if (missingRequiredForRecipient([...fillable.values()], submittedValue, priorResponseFieldIds)) {
    return new Response("Please complete all required fields before signing.", { status: 400 });
  }

  // PHASE 1 (outside the transaction): decode + store signature images as blobs.
  // These are temporary until the transaction commits — if it aborts (lost race,
  // concurrent void, etc.) we delete them, so the "signed" state and its evidence
  // become visible together and never apart.
  let signatureRef: string | null = null;
  const filledAt = new Date();
  const savedRefs: string[] = [];
  const updates: { id: string; value: string; kind: string }[] = [];
  for (const f of fields) {
    const fieldRow = fillable.get(f.id);
    if (!fieldRow) continue;
    let value = f.value;
    if ((fieldRow.kind === "signature" || fieldRow.kind === "initials" || fieldRow.kind === "stamp") && value.startsWith("data:image/")) {
      const b64 = value.split(",")[1] ?? "";
      const ref = await saveFile(Buffer.from(b64, "base64"), `signature-${recipient.id}.png`, "image/png");
      savedRefs.push(ref);
      value = ref;
      if (fieldRow.kind === "signature" && !signatureRef) signatureRef = ref;
    }
    updates.push({ id: f.id, value, kind: fieldRow.kind });
  }

  // PHASE 2: one transaction that RE-VALIDATES everything under a lock, claims the
  // recipient, and writes all fields + the signature ref together. Locking the
  // request row FOR UPDATE closes the sign-vs-void/complete race — a concurrent
  // void must take the same row lock, so it either committed before us (we see it
  // and abort) or waits until we finish.
  try {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; deletedAt: Date | null; expiresAt: Date | null; ordering: string }[]>`
        SELECT "status", "deletedAt", "expiresAt", "ordering" FROM "SignatureRequest" WHERE "id" = ${request.id} FOR UPDATE`;
      const r = rows[0];
      if (!r || r.deletedAt || isRequestClosed(r.status)) {
        throw new SignAbort(409, "This document can no longer be signed.");
      }
      if (r.expiresAt && r.expiresAt < new Date()) {
        throw new SignAbort(409, "This signing link has expired.");
      }
      if (r.ordering === "sequential") {
        const earlier = await tx.signatureRecipient.findFirst({
          where: { requestId: request.id, role: { not: "viewer" }, order: { lt: recipient.order }, status: { not: "signed" } },
          select: { id: true },
        });
        if (earlier) throw new SignAbort(409, "It's not your turn to sign yet.");
      }
      // Claim the recipient AND stamp its signature ref in the same write.
      const claimed = await tx.signatureRecipient.updateMany({
        where: { id: recipient.id, status: { notIn: ["signed", "declined"] } },
        data: {
          status: "signed",
          signedAt: new Date(),
          signedName: name,
          signerIp: meta.ip,
          signerUserAgent: meta.ua,
          ...(signatureRef ? { signatureRef } : {}),
        },
      });
      if (claimed.count === 0) throw new SignAbort(409, "Already signed");
      // Field values land in the same transaction, so they're visible exactly
      // when the recipient becomes "signed".
      //
      // Each recipient's answer is recorded individually in SignatureFieldResponse
      // (one durable row per recipient). SignatureField.value is claimed
      // first-write-wins — it holds the single value the sealed PDF stamps at the
      // field's one placed position. On a SHARED field (recipientId null) this
      // means a later signer's answer no longer overwrites (or, under the old
      // guard, silently vanishes): the stamped value stays the first signer's,
      // while every signer's response is preserved as its own row.
      for (const u of updates) {
        // Each recipient's own durable answer — one row per (field, recipient).
        await tx.signatureFieldResponse.upsert({
          where: { fieldId_recipientId: { fieldId: u.id, recipientId: recipient.id } },
          create: { fieldId: u.id, recipientId: recipient.id, value: u.value, filledAt, tenantId: recipient.tenantId },
          update: { value: u.value, filledAt },
        });
        // The single SignatureField.value the sealed PDF stamps at the field's one
        // placed position. On a shared (unassigned) field two recipients can race,
        // so claim it first-write-wins; an assigned field has one filler, so write
        // it directly (allowing a re-submit to update it).
        const fieldRow = fillable.get(u.id);
        if (fieldRow && fieldRow.recipientId === null) {
          await tx.signatureField.updateMany({ where: { id: u.id, filledAt: null }, data: { value: u.value, filledAt } });
        } else {
          await tx.signatureField.update({ where: { id: u.id }, data: { value: u.value, filledAt } });
        }
      }
    });
  } catch (e) {
    // The transaction never committed — remove the orphaned signature blobs.
    for (const ref of savedRefs) await deleteFile(ref).catch(() => {});
    if (e instanceof SignAbort) return new Response(e.message, { status: e.status });
    throw e;
  }

  for (const u of updates) {
    await logSignEvent(request.id, { type: "field_filled", recipientId: recipient.id, actor: name, channel: "web", metadata: { kind: u.kind } });
  }
  await logSignEvent(request.id, { type: "signed", recipientId: recipient.id, actor: name, channel: "web", ip: meta.ip, userAgent: meta.ua });
  // Surface the signature on the customer's timeline (audit feed). logSignEvent
  // only writes to SignatureEvent, which the contact/lead timelines don't read.
  const auditLead = request.quoteId
    ? (await prisma.quote.findUnique({ where: { id: request.quoteId }, select: { leadId: true } }))?.leadId ?? null
    : null;
  await logAudit({
    action: "signing.signed",
    summary: `${name} signed “${request.title}”`,
    contactId: request.contactId,
    leadId: auditLead,
    userName: name,
    entityType: "SignatureRequest",
    entityId: request.id,
  });
  await advanceAfterSignature(request.id);

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
