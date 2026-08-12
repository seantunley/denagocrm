import { z } from "zod";
import { prisma } from "@/lib/db";
import { saveFile } from "@/lib/storage";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { reqMeta, buildSignEvent } from "@/lib/signing/events";
import { advanceAfterSignature } from "@/lib/signing/workflow";
import { isRequestClosed } from "@/lib/signing/status";
import { missingRequiredForRecipient } from "@/lib/signing/fieldValidation";
import { loadRecipientIdentity, identityStatus } from "@/lib/signing/identity";
import { deleteUnreferencedSigningAssets } from "@/lib/signing/assetCompensation";
import { signingReadiness } from "@/lib/signing/securityPolicy";
import { logAudit } from "@/lib/audit";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { rateLimitSigning } from "@/lib/signing/throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_FIELD_VALUE_BYTES = 800_000;
const MAX_AGGREGATE_FIELD_BYTES = 4 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 512 * 1024;
const MAX_SIGNATURE_DIMENSION = 4096;
const MAX_SIGNATURE_PIXELS = 4_000_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Thrown inside the sign transaction to abort with a specific HTTP status. */
class SignAbort extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const bodySchema = z.object({
  name: z.string().trim().min(2).max(120),
  consent: z.literal(true),
  fields: z.array(z.object({
    id: z.string().min(1).max(128),
    value: z.string().max(MAX_FIELD_VALUE_BYTES),
  })).max(200).default([]),
}).strict();

type Submission = z.infer<typeof bodySchema>;

async function parseSubmission(req: Request): Promise<Submission | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new SignAbort(413, "Submission is too large.");
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length > MAX_REQUEST_BYTES) throw new SignAbort(413, "Submission is too large.");
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return null;
  const ids = parsed.data.fields.map((field) => field.id);
  if (new Set(ids).size !== ids.length) return null;
  const aggregate = parsed.data.fields.reduce((sum, field) => sum + Buffer.byteLength(field.value, "utf8"), 0);
  if (aggregate > MAX_AGGREGATE_FIELD_BYTES) throw new SignAbort(413, "Submitted fields are too large.");
  return parsed.data;
}

function decodeSignaturePng(value: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new SignAbort(400, "Signature images must be PNG files.");
  const encoded = match[1];
  const buffer = Buffer.from(encoded, "base64");
  if (
    buffer.length === 0 ||
    buffer.length > MAX_SIGNATURE_BYTES ||
    buffer.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    throw new SignAbort(400, "The signature image is invalid or too large.");
  }
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_MAGIC) || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new SignAbort(400, "The signature image is not a valid PNG.");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (
    width < 1 || height < 1 ||
    width > MAX_SIGNATURE_DIMENSION || height > MAX_SIGNATURE_DIMENSION ||
    width * height > MAX_SIGNATURE_PIXELS
  ) {
    throw new SignAbort(400, "The signature image dimensions are not allowed.");
  }
  return buffer;
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const readiness = signingReadiness();
  if (!readiness.ready) return new Response("Signing is temporarily unavailable.", { status: 503 });

  // Throttle before ANY database work. Keyed on both the token and the caller's
  // IP: the token bounds abuse of one link, the IP bounds token walking.
  const throttled = await rateLimitSigning(token);
  if (throttled) return throttled;

  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    () => handleSign(token, req),
    () => new Response("Not found", { status: 404 }),
  );
}

async function handleSign(token: string, req: Request): Promise<Response> {
  let submission: Submission | null;
  try {
    submission = await parseSubmission(req);
  } catch (error) {
    if (error instanceof SignAbort) return new Response(error.message, { status: error.status });
    throw error;
  }
  if (!submission) return new Response("Invalid submission", { status: 400 });

  const [recipient, identity] = await Promise.all([
    prisma.signatureRecipient.findUnique({ where: { token: hashSignToken(token) }, include: { request: true } }),
    loadRecipientIdentity(token),
  ]);
  if (!recipient || !identity || !recipient.tenantId) return new Response("Not found", { status: 404 });
  const request = recipient.request;

  // A direct API POST cannot bypass the step-up ceremony shown by the page.
  const assurance = identityStatus(identity);
  if (assurance.required && !assurance.verified) {
    return new Response("Verify your identity before signing.", { status: 403 });
  }

  if (request.deletedAt || isRequestClosed(request.status)) {
    return new Response("This document can no longer be signed.", { status: 409 });
  }
  if (request.expiresAt && request.expiresAt < new Date()) {
    return new Response("This signing link has expired.", { status: 409 });
  }
  if (recipient.status === "signed") return new Response("Already signed", { status: 409 });
  if (recipient.status === "declined") return new Response("You have declined this document.", { status: 409 });
  if (recipient.role === "viewer") return new Response("View only", { status: 403 });

  if (request.ordering === "sequential") {
    const earlier = await prisma.signatureRecipient.findFirst({
      where: {
        requestId: request.id,
        tenantId: recipient.tenantId,
        role: { not: "viewer" },
        order: { lt: recipient.order },
        status: { not: "signed" },
      },
      select: { id: true },
    });
    if (earlier) return new Response("It's not your turn to sign yet.", { status: 409 });
  }

  const { name, fields } = submission;
  const meta = await reqMeta();
  const requestFields = await prisma.signatureField.findMany({
    where: { requestId: request.id, tenantId: recipient.tenantId },
  });
  const fillable = new Map(
    requestFields
      .filter((field) => field.recipientId === recipient.id || field.recipientId === null)
      .map((field) => [field.id, field]),
  );
  if (fields.some((field) => !fillable.has(field.id))) {
    return new Response("The submission contains a field that is not assigned to this signer.", { status: 400 });
  }

  const submittedValue = new Map(fields.map((field) => [field.id, field.value]));
  const priorResponseFieldIds = new Set(
    (
      await prisma.signatureFieldResponse.findMany({
        where: {
          recipientId: recipient.id,
          tenantId: recipient.tenantId,
          field: { requestId: request.id },
        },
        select: { fieldId: true },
      })
    ).map((response) => response.fieldId),
  );
  if (missingRequiredForRecipient([...fillable.values()], submittedValue, priorResponseFieldIds)) {
    return new Response("Please complete all required fields before signing.", { status: 400 });
  }

  // Store image bytes before the database transaction, then positively reconcile
  // them if the transaction throws. A thrown commit acknowledgement is ambiguous:
  // deletion is permitted only when the tenant database proves no row references
  // the object.
  let signatureRef: string | null = null;
  const filledAt = new Date();
  const savedRefs: string[] = [];
  const updates: { id: string; value: string; kind: string }[] = [];
  try {
    for (const field of fields) {
      const fieldRow = fillable.get(field.id)!;
      let value = field.value;
      if (["signature", "initials", "stamp"].includes(fieldRow.kind)) {
        const image = decodeSignaturePng(value);
        // The signature image belongs to the request being signed. There is no
        // session at all here — the caller is a customer holding a signing token —
        // so the RECIPIENT row the token resolved to is the owner, and it is
        // already the tenant every other query on this route is keyed by.
        const ref = await saveFile(
          image,
          `${fieldRow.kind}-${recipient.id}-${fieldRow.id}.png`,
          "image/png",
          recipient.tenantId,
        );
        savedRefs.push(ref);
        value = ref;
        if (fieldRow.kind === "signature" && !signatureRef) signatureRef = ref;
      }
      updates.push({ id: field.id, value, kind: fieldRow.kind });
    }

    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        status: string;
        deletedAt: Date | null;
        expiresAt: Date | null;
        ordering: string;
        identityMode: string;
      }>>`
        SELECT "status", "deletedAt", "expiresAt", "ordering", "identityMode"
        FROM "SignatureRequest"
        WHERE "id" = ${request.id} AND "tenantId" = ${recipient.tenantId}
        FOR UPDATE
      `;
      const lockedRequest = rows[0];
      if (!lockedRequest || lockedRequest.deletedAt || isRequestClosed(lockedRequest.status)) {
        throw new SignAbort(409, "This document can no longer be signed.");
      }
      if (lockedRequest.expiresAt && lockedRequest.expiresAt < new Date()) {
        throw new SignAbort(409, "This signing link has expired.");
      }

      const lockedRecipients = await tx.$queryRaw<Array<{
        status: string;
        identityVerifiedAt: Date | null;
      }>>`
        SELECT "status", "identityVerifiedAt"
        FROM "SignatureRecipient"
        WHERE "id" = ${recipient.id}
          AND "requestId" = ${request.id}
          AND "tenantId" = ${recipient.tenantId}
        FOR UPDATE
      `;
      const lockedRecipient = lockedRecipients[0];
      if (!lockedRecipient || ["signed", "declined"].includes(lockedRecipient.status)) {
        throw new SignAbort(409, "This signing link has already been actioned.");
      }
      if (lockedRequest.identityMode !== "link" && !lockedRecipient.identityVerifiedAt) {
        throw new SignAbort(403, "Verify your identity before signing.");
      }

      if (lockedRequest.ordering === "sequential") {
        const earlier = await tx.signatureRecipient.findFirst({
          where: {
            requestId: request.id,
            tenantId: recipient.tenantId,
            role: { not: "viewer" },
            order: { lt: recipient.order },
            status: { not: "signed" },
          },
          select: { id: true },
        });
        if (earlier) throw new SignAbort(409, "It's not your turn to sign yet.");
      }

      const claimed = await tx.signatureRecipient.updateMany({
        where: {
          id: recipient.id,
          tenantId: recipient.tenantId,
          status: { notIn: ["signed", "declined"] },
        },
        data: {
          status: "signed",
          signedAt: filledAt,
          signedName: name,
          signerIp: meta.ip,
          signerUserAgent: meta.ua,
          ...(signatureRef ? { signatureRef } : {}),
        },
      });
      if (claimed.count === 0) throw new SignAbort(409, "Already signed");

      for (const update of updates) {
        await tx.signatureFieldResponse.upsert({
          where: { fieldId_recipientId: { fieldId: update.id, recipientId: recipient.id } },
          create: {
            fieldId: update.id,
            recipientId: recipient.id,
            value: update.value,
            filledAt,
            tenantId: recipient.tenantId,
          },
          update: { value: update.value, filledAt },
        });
        const fieldRow = fillable.get(update.id);
        if (fieldRow?.recipientId === null) {
          await tx.signatureField.updateMany({
            where: { id: update.id, tenantId: recipient.tenantId, filledAt: null },
            data: { value: update.value, filledAt },
          });
        } else {
          await tx.signatureField.update({ where: { id: update.id }, data: { value: update.value, filledAt } });
        }
        await tx.signatureEvent.create({
          data: buildSignEvent(request.id, {
            recipientId: recipient.id,
            type: "field_filled",
            actor: name,
            channel: "web",
            metadata: { kind: update.kind },
          }),
        });
      }
      await tx.signatureEvent.create({
        data: buildSignEvent(request.id, {
          recipientId: recipient.id,
          type: "signed",
          actor: name,
          channel: "web",
          ip: meta.ip,
          userAgent: meta.ua,
          metadata: { identityMode: lockedRequest.identityMode },
        }),
      });
      // SignatureRecipient_enqueue_transition runs after the status update and
      // commits the durable continuation job in this same transaction.
    });
  } catch (error) {
    await deleteUnreferencedSigningAssets(recipient.tenantId, savedRefs);
    if (error instanceof SignAbort) return new Response(error.message, { status: error.status });
    throw error;
  }

  // The legal evidence and transition outbox are already committed. CRM timeline
  // and inline advancement improve responsiveness but can no longer make the
  // signature appear to fail after it was durably accepted.
  const auditLead = request.quoteId
    ? await prisma.quote.findUnique({
        where: { id: request.quoteId },
        select: { leadId: true },
      }).then((quote) => quote?.leadId ?? null).catch(() => null)
    : null;
  await logAudit({
    action: "signing.signed",
    summary: `${name} signed “${request.title}”`,
    contactId: request.contactId,
    leadId: auditLead,
    userName: name,
    entityType: "SignatureRequest",
    entityId: request.id,
  }).catch(() => {});
  await advanceAfterSignature(request.id).catch(() => {});

  return Response.json({ ok: true });
}
