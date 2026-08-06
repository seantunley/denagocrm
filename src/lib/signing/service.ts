import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { formatDate } from "@/lib/format";
import { getCompanyProfile, companyTokens } from "@/lib/companyProfile";
import type { DocumentModel } from "@/lib/doceditor/model";
import { freezeDocumentGlobals } from "@/lib/signing/freezeDocument";
import { newSignCapability } from "./tokenVault";
import { normalizePhone } from "@/lib/sms";
import { currentTenantScope } from "@/lib/tenantScope";
import { getActiveTenantId } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { payableTotalCents } from "@/lib/pricing";
import {
  resolveIdentityMode, parseOtpPolicy, parseOtpMinValue,
  SIGNING_OTP_POLICY_KEY, SIGNING_OTP_MIN_VALUE_KEY,
} from "./identityPolicy";
import { buildSignEvent } from "./events";

export type RequestSource = {
  documentId?: string | null;
  quoteId?: string | null;
  jobCardId?: string | null;
  contactId?: string | null;
  templateId?: string | null;
};

/**
 * How hard a signer must prove they are the intended recipient.
 *
 *   link      possession of the emailed URL is enough (the historic behaviour)
 *   email_otp a one-time code to the email address on file
 *   sms_otp   a one-time code to the mobile number on file
 *   otp       a code to either — the signer picks whichever they still have
 *
 * `otp` is usually the right choice when a document matters: it asks for real
 * proof without betting the signature on one channel still working, which is the
 * common failure (a stale mobile number, a mailbox the customer has left behind).
 */
export type SigningIdentityMode = "link" | "email_otp" | "sms_otp" | "otp";

/**
 * What this document is worth, for the money-attached policy.
 *
 * Null means "nothing with a value is attached" — a document with no source
 * record, or a job card, which carries work rather than a price. Returning 0 for
 * those would make them look like a zero-value quote and quietly pull them into
 * whatever the threshold is.
 *
 * Any failure reads as null rather than throwing: a pricing problem must not
 * stop a document being sent for signature.
 */
/** The tenant the source record belongs to, whichever kind of record it is. */
async function sourceTenantId(source: RequestSource): Promise<string | null> {
  try {
    if (source.quoteId) {
      return (await basePrisma.quote.findUnique({ where: { id: source.quoteId }, select: { tenantId: true } }))?.tenantId ?? null;
    }
    if (source.jobCardId) {
      return (await basePrisma.jobCard.findUnique({ where: { id: source.jobCardId }, select: { tenantId: true } }))?.tenantId ?? null;
    }
    if (source.documentId) {
      return (await basePrisma.document.findUnique({ where: { id: source.documentId }, select: { tenantId: true } }))?.tenantId ?? null;
    }
  } catch {
    // Fall through to the session's tenant rather than failing the send.
  }
  return null;
}

async function documentValue(source: RequestSource): Promise<number | null> {
  if (!source.quoteId) return null;
  try {
    const quote = await basePrisma.quote.findUnique({
      where: { id: source.quoteId },
      select: { items: true, fees: true, taxInclusive: true, depositType: true, depositValue: true },
    });
    if (!quote) return null;
    return payableTotalCents(quote as Parameters<typeof payableTotalCents>[0]) / 100;
  } catch {
    return null;
  }
}

export async function createSignatureRequestFromDoc(opts: {
  doc: DocumentModel;
  title: string;
  unsignedPdfRef: string | null;
  source: RequestSource;
  ordering?: "parallel" | "sequential";
  message?: string;
  createdById?: string | null;
  identityMode?: SigningIdentityMode;
  client?: Prisma.TransactionClient;
}): Promise<{ id: string; recipients: number; fields: number; identityMode: SigningIdentityMode }> {
  const { source } = opts;
  const frozenDoc = freezeDocumentGlobals(opts.doc, {
    ...companyTokens(await getCompanyProfile()),
    "date.today": formatDate(new Date()),
  });
  // Whether the signer must prove who they are.
  //
  // The workspace policy decides the default — MONEY out of the box, so a quote
  // asks for a one-time code and a delivery note does not — and whoever prepared
  // this document can override it for this document. A person looking at the
  // specific thing in front of them outranks a global setting.
  //
  // Never escalated by an environment variable: adding a step every signer was
  // told nothing about is how a security control turns into a support call.
  const [policyRaw, minValueRaw] = await Promise.all([
    getSetting(SIGNING_OTP_POLICY_KEY).catch(() => null),
    getSetting(SIGNING_OTP_MIN_VALUE_KEY).catch(() => null),
  ]);
  const identityMode: SigningIdentityMode = resolveIdentityMode({
    explicit: opts.identityMode ?? null,
    policy: parseOtpPolicy(policyRaw),
    minValue: parseOtpMinValue(minValueRaw),
    value: { amount: await documentValue(source) },
  });

  // The mobile number "on file" is the linked contact's — the document model
  // carries a name, an email and a role, but no phone. Resolved once here, at
  // send time, so an SMS code goes to the number the CRM actually holds for this
  // customer rather than to something typed into a template months ago.
  const contactOnFile = source.contactId
    ? await basePrisma.contact.findUnique({
        where: { id: source.contactId },
        select: { phone: true, email: true, tenantId: true },
      })
    : null;
  const contactPhone = contactOnFile?.phone ? normalizePhone(contactOnFile.phone) : null;
  const contactEmail = contactOnFile?.email?.trim().toLowerCase() || null;

  // Raw capabilities, keyed by the recipient row they belong to. They exist here
  // only for the caller that has to build a URL, and are never written anywhere
  // in this form — the database holds a digest, so there is no way to recover
  // them afterwards and no reason to want to.
  const rawCapabilities = new Map<string, string>();

  // The owning tenant, resolved and written EXPLICITLY.
  //
  // The stamping trigger now fails closed, and basePrisma pins app.bypass_rls
  // rather than app.current_tenant — so leaving tenantId to be inferred meant
  // the trigger had nothing to infer from and refused every new signature
  // request. Making the trigger strict without giving the ordinary path a way
  // to satisfy it turned a safety net into a wall.
  //
  // Derived from the source record first (that is the tenant the document
  // actually belongs to), then the acting session.
  const ownerTenantId =
    contactOnFile?.tenantId
    ?? (await sourceTenantId(source))
    ?? currentTenantScope()?.tenantId
    ?? (await getActiveTenantId());
  if (!ownerTenantId) {
    throw new Error("Cannot create a signature request without an owning tenant.");
  }

  const writes = async (db: Prisma.TransactionClient) => {
    const request = await db.signatureRequest.create({
      data: {
        title: opts.title,
        tenantId: ownerTenantId,
        status: "draft",
        identityMode,
        ordering: opts.ordering ?? "parallel",
        message: opts.message ?? null,
        documentId: source.documentId ?? null,
        quoteId: source.quoteId ?? null,
        jobCardId: source.jobCardId ?? null,
        contactId: source.contactId ?? null,
        templateId: source.templateId ?? null,
        snapshotJson: frozenDoc as object,
        unsignedPdfRef: opts.unsignedPdfRef,
        createdById: opts.createdById ?? null,
      },
    });

    const idMap = new Map<string, string>();
    for (let index = 0; index < frozenDoc.recipients.length; index += 1) {
      const recipient = frozenDoc.recipients[index];
      const capability = newSignCapability();
      const row = await db.signatureRecipient.create({
        data: {
          requestId: request.id,
          name: recipient.name || `Recipient ${index + 1}`,
          email: recipient.email || null,
          // Only the party this contact actually is. Copying the contact's mobile
          // onto every recipient would send the customer's verification code to
          // the salesperson's row as well.
          phone:
            contactPhone &&
            (recipient.party === "customer" ||
              (contactEmail !== null && recipient.email.trim().toLowerCase() === contactEmail))
              ? contactPhone
              : null,
          role: recipient.role,
          order: index,
          color: recipient.color,
          // The DIGEST is the stored value and the lookup key; the raw capability
          // leaves this function only inside the URL that gets delivered. The
          // ciphertext is kept solely so a reminder can repeat the same link.
          token: capability.digest,
          tokenCiphertext: capability.ciphertext,
        },
      });
      // Carried out of the transaction so the delivery step can build the URL
      // without ever reading the raw value back from the database — there is no
      // path that does, because nothing readable was written.
      rawCapabilities.set(row.id, capability.raw);
      idMap.set(recipient.id, row.id);
    }

    const fieldsData = frozenDoc.pages.flatMap((page, pageIndex) =>
      page.overlayFields.map((field) => ({
        requestId: request.id,
        recipientId: field.recipientId ? idMap.get(field.recipientId) ?? null : null,
        kind: field.kind,
        page: pageIndex,
        x: field.anchor.x,
        y: field.anchor.y,
        width: field.width,
        height: field.height,
        required: field.required,
        label: field.label,
      })),
    );
    if (fieldsData.length) await db.signatureField.createMany({ data: fieldsData });

    await db.signatureEvent.create({
      data: buildSignEvent(request.id, {
        type: "created",
        actor: "system",
        metadata: {
          title: opts.title,
          recipients: frozenDoc.recipients.length,
          fields: fieldsData.length,
          identityMode,
          capabilityStorage: "sha256-digest+aes-256-gcm-ciphertext",
        },
      }),
    });

    return { id: request.id, recipients: frozenDoc.recipients.length, fields: fieldsData.length, identityMode };
  };

  const result = opts.client
    ? await writes(opts.client)
    : await basePrisma.$transaction((tx) => writes(tx));

  await logAudit({
    action: "signing.create",
    summary: `Created signature request “${opts.title}” (${result.identityMode})`,
    entityType: "SignatureRequest",
    entityId: result.id,
  });
  return result;
}
