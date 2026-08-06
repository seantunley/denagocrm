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
  // Defaults to `link`, and is NOT escalated automatically by any global switch.
  //
  // A step-up is a real improvement — a forwarded email, a shared inbox or a
  // mail-scanning proxy can all open a link-only document — but which documents
  // are worth asking a customer for a code is a business judgement. Turning it on
  // for everything by flipping an environment variable would silently add a step
  // to every delivery note and every signer who was never told to expect one.
  const identityMode: SigningIdentityMode = opts.identityMode ?? "link";

  // The mobile number "on file" is the linked contact's — the document model
  // carries a name, an email and a role, but no phone. Resolved once here, at
  // send time, so an SMS code goes to the number the CRM actually holds for this
  // customer rather than to something typed into a template months ago.
  const contactOnFile = source.contactId
    ? await basePrisma.contact.findUnique({
        where: { id: source.contactId },
        select: { phone: true, email: true },
      })
    : null;
  const contactPhone = contactOnFile?.phone ? normalizePhone(contactOnFile.phone) : null;
  const contactEmail = contactOnFile?.email?.trim().toLowerCase() || null;

  // Raw capabilities, keyed by the recipient row they belong to. They exist here
  // only for the caller that has to build a URL, and are never written anywhere
  // in this form — the database holds a digest, so there is no way to recover
  // them afterwards and no reason to want to.
  const rawCapabilities = new Map<string, string>();

  const writes = async (db: Prisma.TransactionClient) => {
    const request = await db.signatureRequest.create({
      data: {
        title: opts.title,
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
