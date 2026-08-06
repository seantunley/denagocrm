import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { saveFile, deleteFile } from "@/lib/storage";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { reqMeta } from "@/lib/signing/events";
import { advanceAfterSignature } from "@/lib/signing/workflow";
import { isRequestClosed, isRequestProcessing } from "@/lib/signing/status";
import { missingRequiredForRecipient } from "@/lib/signing/fieldValidation";
import { logAudit } from "@/lib/audit";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { rateLimitSigning } from "@/lib/signing/throttle";
import { requireIdentityForToken } from "@/lib/signing/identity";
import { decodeAndValidateSignaturePng } from "@/lib/signing/signatureImage";
import { registerArtifactUpload, markArtifactState } from "@/lib/signing/artifactCustody";
import { signingReleaseId } from "@/lib/signing/securityConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

class SignAbort extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const fieldSchema = z.object({ id: z.string().min(1).max(128), value: z.string().max(1_500_000) });
const bodySchema = z.object({
  name: z.string().trim().min(2).max(120),
  consent: z.literal(true),
  fields: z.array(fieldSchema).max(100).default([]),
});
const unavailable = (status: string) => isRequestClosed(status) || isRequestProcessing(status);

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 4 * 1024 * 1024) return new Response("Submission is too large", { status: 413 });
  const throttled = await rateLimitSigning(token);
  if (throttled) return throttled;
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    () => handleSign(token, request),
    () => new Response("Not found", { status: 404 }),
  );
}

async function handleSign(rawToken: string, request: Request): Promise<Response> {
  let identity;
  try { identity = await requireIdentityForToken(rawToken); }
  catch (error) { return new Response(error instanceof Error ? error.message : "Identity verification required", { status: 403 }); }

  const digest = hashSignToken(rawToken);
  const recipient = await prisma.signatureRecipient.findUnique({ where: { token: digest }, include: { request: true } });
  if (!recipient?.tenantId) return new Response("Not found", { status: 404 });
  const envelope = recipient.request;
  if (envelope.deletedAt || unavailable(envelope.status)) return new Response("This document can no longer be signed.", { status: 409 });
  if (envelope.expiresAt && envelope.expiresAt < new Date()) return new Response("This signing link has expired.", { status: 409 });
  if (recipient.status === "signed") return new Response("Already signed", { status: 409 });
  if (recipient.status === "declined") return new Response("You have declined this document.", { status: 409 });
  if (recipient.role === "viewer") return new Response("View only", { status: 403 });

  if (envelope.ordering === "sequential") {
    const earlier = await prisma.signatureRecipient.findFirst({
      where: { requestId: envelope.id, role: { not: "viewer" }, order: { lt: recipient.order }, status: { not: "signed" } },
      select: { id: true },
    });
    if (earlier) return new Response("It's not your turn to sign yet.", { status: 409 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response("Invalid submission", { status: 400 });
  const { name, fields } = parsed.data;
  if (fields.reduce((sum, field) => sum + field.value.length, 0) > 3_000_000) return new Response("Submission is too large", { status: 413 });
  const meta = await reqMeta();
  const requestFields = await prisma.signatureField.findMany({ where: { requestId: envelope.id } });
  const fillable = new Map(requestFields.filter((field) => field.recipientId === recipient.id || field.recipientId === null).map((field) => [field.id, field]));
  const submitted = new Map(fields.map((field) => [field.id, field.value]));
  const prior = new Set((await prisma.signatureFieldResponse.findMany({
    where: { recipientId: recipient.id, field: { requestId: envelope.id } }, select: { fieldId: true },
  })).map((row) => row.fieldId));
  if (missingRequiredForRecipient([...fillable.values()], submitted, prior)) {
    return new Response("Please complete all required fields before signing.", { status: 400 });
  }

  const consentRows = await basePrisma.$queryRaw<Array<{ consentVersion: string }>>(Prisma.sql`
    SELECT "consentVersion" FROM "SignatureRequest" WHERE id=${envelope.id} LIMIT 1
  `);
  const consentVersion = consentRows[0]?.consentVersion || "historic";
  const filledAt = new Date();
  const savedRefs: string[] = [];
  let signatureRef: string | null = null;
  const updates: Array<{ id: string; value: string; kind: string }> = [];

  try {
    for (const submittedField of fields) {
      const field = fillable.get(submittedField.id);
      if (!field) continue;
      let value = submittedField.value;
      if (["signature", "initials", "stamp"].includes(field.kind)) {
        if (!value.startsWith("data:image/png;base64,")) throw new SignAbort(400, `Field ${field.label || field.kind} must contain a valid PNG signature`);
        const image = decodeAndValidateSignaturePng(value);
        const ref = await saveFile(image.buffer, `signature-${recipient.id}.png`, "image/png");
        savedRefs.push(ref);
        await registerArtifactUpload({ tenantId: recipient.tenantId, envelopeId: envelope.id, kind: "signature_image", objectRef: ref, bytes: image.buffer, sha256: image.sha256 });
        value = ref;
        if (field.kind === "signature" && !signatureRef) signatureRef = ref;
      }
      updates.push({ id: submittedField.id, value, kind: field.kind });
    }

    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string; deletedAt: Date | null; expiresAt: Date | null; ordering: string }>>(Prisma.sql`
        SELECT status,"deletedAt","expiresAt",ordering FROM "SignatureRequest" WHERE id=${envelope.id} FOR UPDATE
      `);
      const locked = rows[0];
      if (!locked || locked.deletedAt || unavailable(locked.status)) throw new SignAbort(409, "This document can no longer be signed.");
      if (locked.expiresAt && locked.expiresAt < new Date()) throw new SignAbort(409, "This signing link has expired.");
      if (locked.ordering === "sequential") {
        const earlier = await tx.signatureRecipient.findFirst({
          where: { requestId: envelope.id, role: { not: "viewer" }, order: { lt: recipient.order }, status: { not: "signed" } }, select: { id: true },
        });
        if (earlier) throw new SignAbort(409, "It's not your turn to sign yet.");
      }
      const claimed = await tx.signatureRecipient.updateMany({
        where: { id: recipient.id, status: { notIn: ["signed", "declined"] } },
        data: { status: "signed", signedAt: new Date(), signedName: name, signerIp: meta.ip, signerUserAgent: meta.ua, ...(signatureRef ? { signatureRef } : {}) },
      });
      if (!claimed.count) throw new SignAbort(409, "Already signed");

      for (const update of updates) {
        await tx.signatureFieldResponse.upsert({
          where: { fieldId_recipientId: { fieldId: update.id, recipientId: recipient.id } },
          create: { tenantId: recipient.tenantId, fieldId: update.id, recipientId: recipient.id, value: update.value, filledAt },
          update: { value: update.value, filledAt },
        });
        const field = fillable.get(update.id);
        if (field?.recipientId === null) await tx.signatureField.updateMany({ where: { id: update.id, filledAt: null }, data: { value: update.value, filledAt } });
        else await tx.signatureField.update({ where: { id: update.id }, data: { value: update.value, filledAt } });
        await tx.signatureEvent.create({
          data: { tenantId: recipient.tenantId, requestId: envelope.id, recipientId: recipient.id, type: "field_filled", actor: name, channel: "web", metadata: { kind: update.kind } },
        });
      }
      await tx.signatureEvent.create({
        data: {
          tenantId: recipient.tenantId, requestId: envelope.id, recipientId: recipient.id, type: "signed", actor: name, channel: "web",
          ip: meta.ip, userAgent: meta.ua,
          metadata: {
            consent: true,
            consentVersion,
            consentText: "I confirm that I have reviewed this document and consent to sign it electronically.",
            authMethod: identity.policy === "ES1_LINK" ? "link"
              : identity.policy === "ES2_EMAIL_OTP" ? "email_otp"
              : identity.policy === "ES2_SMS_OTP" ? "sms_otp"
              : identity.policy === "ES2_EMAIL_SMS" ? "email_otp+sms_otp"
              : identity.policy === "ES2_AUTHENTICATED_PORTAL" ? "authenticated_portal"
              : identity.policy === "ES3_PASSKEY" ? "passkey"
              : identity.policy,
            assuranceLevel: identity.policy === "ES1_LINK" ? "ES-1" : identity.policy === "ES3_PASSKEY" ? "ES-3" : "ES-2",
            releaseId: signingReleaseId(),
          },
        },
      });
      await tx.signatureRequest.updateMany({
        where: { id: envelope.id, status: { in: ["prepared", "dispatching", "active", "sent", "viewed"] } }, data: { status: "signing" },
      });
      for (const ref of savedRefs) await markArtifactState({ tenantId: recipient.tenantId, objectRef: ref, kind: "signature_image", envelopeId: envelope.id, state: "referenced" }, tx);
    });
  } catch (error) {
    for (const ref of savedRefs) await deleteFile(ref).catch(() => {});
    if (error instanceof SignAbort) return new Response(error.message, { status: error.status });
    throw error;
  }

  const leadId = envelope.quoteId ? (await prisma.quote.findUnique({ where: { id: envelope.quoteId }, select: { leadId: true } }))?.leadId ?? null : null;
  await logAudit({
    action: "signing.signed", summary: `${name} signed “${envelope.title}”`, contactId: envelope.contactId, leadId,
    userName: name, entityType: "SignatureRequest", entityId: envelope.id,
  });
  await advanceAfterSignature(envelope.id).catch(() => {});
  return Response.json({ ok: true, queuedRecovery: true });
}
