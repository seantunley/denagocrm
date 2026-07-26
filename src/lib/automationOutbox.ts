import "server-only";

import { PDFDocument } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { basePrisma, prisma } from "./db";
import { buildMergeContext, htmlToPdf, renderInstanceHtml } from "./customDocs";
import { resolveBlocks } from "./mergeFields";
import { contactName } from "./format";
import { deleteFile, readFile, saveFile } from "./storage";
import { resolveTenantActor } from "./tenantActor";
import { createSignatureRequestFromDoc } from "./signing/service";
import { dispatchRequest } from "./signing/dispatch";
import type { DocumentModel } from "./doceditor/model";

const MAX_ATTEMPTS = 3;

function object(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function value(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function source(payload: Record<string, unknown>) {
  return object(payload.source as Prisma.JsonValue | undefined);
}

async function documentInstanceForOutbox(outboxId: string) {
  const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "DocInstance"
    WHERE "deletedAt" IS NULL AND "snapshotJson" ->> 'automationOutboxId' = ${outboxId}
    ORDER BY "createdAt" DESC LIMIT 1`;
  return rows[0]?.id
    ? prisma.docInstance.findUnique({ where: { id: rows[0].id } })
    : null;
}

async function generateDocument(item: {
  id: string;
  tenantId: string | null;
  payload: Prisma.JsonValue;
}) {
  const payload = object(item.payload);
  const eventSource = source(payload);
  const actor = await resolveTenantActor();
  if (!actor) throw new Error("No active user is available to generate the document");

  const templateId = value(payload.templateId);
  const template = templateId
    ? await prisma.customDocTemplate.findFirst({ where: { id: templateId, deletedAt: null } })
    : await prisma.customDocTemplate.findFirst({ where: { deletedAt: null }, orderBy: { updatedAt: "desc" } });
  if (!template) throw new Error("No Document Studio template is available");

  const latestVersion = await prisma.customDocVersion.findFirst({
    where: { templateId: template.id },
    orderBy: { version: "desc" },
  });
  const contactId = value(payload.contactId) ?? value(eventSource.contactId);
  const leadId = value(payload.leadId) ?? value(eventSource.leadId);
  const quoteId = value(payload.quoteId)
    ?? value(eventSource.quoteId)
    ?? (eventSource.entityType === "Quote" ? value(eventSource.id) : null);
  const title = value(payload.title) ?? `${template.name} — automated`;

  let instance = await documentInstanceForOutbox(item.id);
  if (!instance) {
    const context = await buildMergeContext({ contactId, leadId, quoteId, userName: actor.name });
    const resolved = resolveBlocks(latestVersion?.contentJson ?? template.draftJson, context);
    instance = await prisma.docInstance.create({
      data: {
        tenantId: item.tenantId,
        title,
        contentJson: resolved as object,
        snapshotJson: { ...context, automationOutboxId: item.id } as object,
        contactId,
        leadId,
        quoteId,
        templateId: template.id,
        templateVersionId: latestVersion?.id ?? null,
        createdById: actor.id,
      },
    });
  }

  if (instance.status === "final" && instance.pdfDocId) {
    return { docInstanceId: instance.id, documentId: instance.pdfDocId };
  }

  const html = await renderInstanceHtml({ title: instance.title, contentJson: instance.contentJson });
  const pdf = await htmlToPdf(html);
  const storedName = await saveFile(pdf, `${instance.title}.pdf`, "application/pdf");
  let committed = false;
  try {
    const document = await basePrisma.$transaction(async (tx) => {
      const locked = await tx.docInstance.findUnique({ where: { id: instance!.id } });
      if (!locked || locked.deletedAt) throw new Error("Generated document instance was removed");
      if (locked.status === "final" && locked.pdfDocId) {
        return tx.document.findUniqueOrThrow({ where: { id: locked.pdfDocId } });
      }
      const created = await tx.document.create({
        data: {
          tenantId: item.tenantId,
          fileName: `${locked.title}.pdf`,
          storedName,
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
          contactId: locked.contactId,
          quoteId: locked.quoteId,
          tag: "generated-pdf",
          uploadedById: actor.id,
        },
      });
      await tx.docInstance.update({
        where: { id: locked.id },
        data: { status: "final", finalizedAt: new Date(), pdfDocId: created.id },
      });
      return created;
    });
    committed = document.storedName === storedName;
    return { docInstanceId: instance.id, documentId: document.id };
  } finally {
    if (!committed) await deleteFile(storedName).catch(() => {});
  }
}

async function signingRequestForOutbox(outboxId: string) {
  const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "SignatureRequest" WHERE "automationOutboxId" = ${outboxId} LIMIT 1`;
  return rows[0]?.id ?? null;
}

async function resolveSigningDocument(item: {
  id: string;
  journeyRunId: string | null;
  payload: Prisma.JsonValue;
}) {
  const payload = object(item.payload);
  const eventSource = source(payload);
  const explicit = value(payload.documentId);
  if (explicit) return prisma.document.findFirst({ where: { id: explicit, deletedAt: null } });

  if (item.journeyRunId) {
    const generated = await prisma.automationOutbox.findFirst({
      where: { journeyRunId: item.journeyRunId, kind: "document.generate", status: "completed" },
      orderBy: { completedAt: "desc" },
    });
    const result = object(object(generated?.payload).result as Prisma.JsonValue | undefined);
    const generatedId = value(result.documentId);
    if (generatedId) return prisma.document.findFirst({ where: { id: generatedId, deletedAt: null } });
  }

  const quoteId = value(payload.quoteId) ?? value(eventSource.quoteId) ?? (eventSource.entityType === "Quote" ? value(eventSource.id) : null);
  const jobCardId = value(payload.jobCardId) ?? value(eventSource.jobCardId) ?? (eventSource.entityType === "JobCard" ? value(eventSource.id) : null);
  if (quoteId) return prisma.document.findFirst({ where: { quoteId, deletedAt: null }, orderBy: { createdAt: "desc" } });
  if (jobCardId) return prisma.document.findFirst({ where: { jobCardId, deletedAt: null }, orderBy: { createdAt: "desc" } });
  return null;
}

function signingModel(args: {
  title: string;
  recipient: { name: string; email: string | null };
  pages: number;
}): DocumentModel {
  const recipientId = "automation_recipient";
  return {
    schemaVersion: 1,
    title: args.title,
    style: { fontFamily: "sans", pageSize: "A4", margin: 48, accent: "#ea580c", ink: "#020617" },
    recipients: [{ id: recipientId, name: args.recipient.name, email: args.recipient.email ?? "", role: "signer", color: "#2563eb" }],
    pages: Array.from({ length: Math.max(1, args.pages) }, (_, index) => ({
      id: `page_${index + 1}`,
      rows: [],
      floatingBlocks: [],
      overlayFields: index === Math.max(1, args.pages) - 1 ? [{
        id: "automation_signature",
        kind: "signature",
        anchor: { mode: "page", blockId: null, x: 520, y: 965 },
        width: 200,
        height: 64,
        recipientId,
        required: true,
        label: "Signature",
        options: [],
      }] : [],
    })),
    header: [],
    footer: [],
  };
}

async function createSigningRequest(item: {
  id: string;
  tenantId: string | null;
  journeyRunId: string | null;
  payload: Prisma.JsonValue;
}) {
  const existing = await signingRequestForOutbox(item.id);
  if (existing) return { requestId: existing, reused: true };
  const payload = object(item.payload);
  const eventSource = source(payload);
  let document = await resolveSigningDocument(item);
  if (!document && value(payload.templateId)) {
    const generated = await generateDocument({ id: item.id, tenantId: item.tenantId, payload: item.payload });
    document = await prisma.document.findFirst({ where: { id: generated.documentId, deletedAt: null } });
  }
  if (!document) throw new Error("No generated or linked document is available for signing");
  const contactId = document.contactId ?? value(payload.contactId) ?? value(eventSource.contactId);
  if (!contactId) throw new Error("The signing document is not linked to a contact");
  const contact = await prisma.contact.findFirst({ where: { id: contactId, deletedAt: null } });
  if (!contact) throw new Error("Signing contact not found");
  const actor = await resolveTenantActor();
  if (!actor) throw new Error("No active user is available to create the signing request");

  const pdf = await readFile(document.storedName);
  const parsed = await PDFDocument.load(pdf);
  const title = value(payload.title) ?? document.fileName.replace(/\.pdf$/i, "");
  const doc = signingModel({ title, recipient: { name: contactName(contact), email: contact.email }, pages: parsed.getPageCount() });
  const quoteId = document.quoteId ?? value(payload.quoteId) ?? value(eventSource.quoteId);
  const jobCardId = document.jobCardId ?? value(payload.jobCardId) ?? value(eventSource.jobCardId);

  const created = await basePrisma.$transaction(async (tx) => {
    const concurrent = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "SignatureRequest" WHERE "automationOutboxId" = ${item.id} LIMIT 1`;
    if (concurrent[0]) return { id: concurrent[0].id, recipients: 0, fields: 0, reused: true };
    const request = await createSignatureRequestFromDoc({
      doc,
      title,
      unsignedPdfRef: document.storedName,
      source: { documentId: document.id, quoteId, jobCardId, contactId },
      createdById: actor.id,
      client: tx,
    });
    await tx.$executeRaw`UPDATE "SignatureRequest" SET "automationOutboxId" = ${item.id} WHERE "id" = ${request.id}`;
    return { ...request, reused: false };
  });

  let notified = 0;
  if (!created.reused && contact.email) {
    const result = await dispatchRequest(created.id);
    notified = result.notified;
  }
  return { requestId: created.id, notified, reused: created.reused };
}

async function processOne(item: {
  id: string;
  tenantId: string | null;
  kind: string;
  journeyRunId: string | null;
  payload: Prisma.JsonValue;
  attempts: number;
}) {
  const claimed = await prisma.automationOutbox.updateMany({
    where: { id: item.id, status: "pending", availableAt: { lte: new Date() } },
    data: { status: "processing", attempts: { increment: 1 }, error: null },
  });
  if (!claimed.count) return false;

  try {
    const result = item.kind === "document.generate"
      ? await generateDocument(item)
      : item.kind === "signing.create_request"
        ? await createSigningRequest(item)
        : null;
    if (!result) throw new Error(`No automation outbox processor is registered for ${item.kind}`);
    const payload = object(item.payload);
    await prisma.automationOutbox.update({
      where: { id: item.id },
      data: { status: "completed", completedAt: new Date(), payload: { ...payload, result } as Prisma.InputJsonValue },
    });
    return true;
  } catch (error) {
    const attempts = item.attempts + 1;
    const retry = attempts < MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message : "Unknown automation outbox error";
    await prisma.automationOutbox.update({
      where: { id: item.id },
      data: {
        status: retry ? "pending" : "failed",
        availableAt: retry ? new Date(Date.now() + 5 * 60_000) : new Date(),
        error: message.slice(0, 1000),
      },
    });
    return false;
  }
}

export async function recoverStaleAutomationOutbox() {
  return prisma.automationOutbox.updateMany({
    where: { status: "processing", updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
    data: { status: "pending", availableAt: new Date(), error: "Recovered stale outbox item" },
  });
}

export async function processAutomationOutbox(limit = 20) {
  const rows = await prisma.automationOutbox.findMany({
    where: { status: "pending", availableAt: { lte: new Date() }, kind: { in: ["document.generate", "signing.create_request"] } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let completed = 0;
  for (const row of rows) if (await processOne(row)) completed += 1;
  return { processed: rows.length, completed };
}
