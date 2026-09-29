"use server";

/**
 * Custom documents in the one document editor — the Studio free-form documents'
 * replacement (step 4 of docs/single-document-editor-plan).
 *
 * A custom document is a `DocInstance` row with `docModelJson` set: a per-record
 * COPY of a "custom" doc-editor template, merge data frozen in at creation,
 * edited in /doc-editor/document/[id], and finalised into a filed PDF that locks
 * it. Legacy Studio rows (no `docModelJson`) stay with actions/studio.ts.
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { saveFile } from "@/lib/storage";
import { asActionResult, refuse } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { requireAnyPermission, requirePermission } from "@/lib/permissions";
import { buildMergeContext } from "@/lib/customDocs";
import { buildQuoteContext } from "@/lib/docbuilder/merge";
import { loadBillToFleet } from "@/lib/quoteBillTo";
import { getLiveBuilderTemplate } from "@/lib/docbuilder/store";
import { RECORD_UNAVAILABLE } from "@/lib/docbuilder/recordAccess";
import { listStudioClauses } from "@/lib/docTemplateStore";
import { documentSchema, parseDocument } from "@/lib/doceditor/model";
import { blankDocument } from "@/lib/doceditor/factory";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import { renderModelToPdf } from "@/lib/doceditor/generate";
import { blockNoteToBlocks, blockNoteToDocument } from "@/lib/doceditor/blocknote";
import { canAccessDocumentLinks } from "@/lib/doceditor/instanceAccess";
import {
  combineTokens,
  customDocumentEditable,
  freezeDocumentTokens,
  renderSnapshot,
  type CustomDocSnapshot,
} from "@/lib/doceditor/customDocument";

/** The doc-editor template key that custom documents are made from. */
const CUSTOM_KEY = "custom";
const STUDIO = "/document-studio";
const editorPath = (id: string) => `/doc-editor/document/${id}`;

/** Load a custom document the caller may edit, or refuse. Same answer for missing and forbidden. */
async function editableDocument(id: string) {
  const user = await requirePermission("documents.manage");
  const row = await prisma.docInstance.findUnique({ where: { id } });
  if (!row || row.deletedAt || row.docModelJson == null || !(await canAccessDocumentLinks(user, row))) {
    refuse("That document isn't available.");
  }
  return { user, row };
}

/** Create a custom document from a "custom" template (or blank) for optional customer/quote/deal. */
export async function createCustomDocument(formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("documents.manage");
    const field = (name: string) => String(formData.get(name) ?? "").trim() || null;
    const templateId = field("templateId");
    const contactId = field("contactId");
    const leadId = field("leadId");
    const quoteId = field("quoteId");
    if (!(await canAccessDocumentLinks(user, { contactId, leadId, quoteId }))) refuse(RECORD_UNAVAILABLE);

    // The PUBLISHED layout, like every other document filed against a record.
    let model = blankDocument(field("title") ?? "Untitled document");
    if (templateId) {
      const template = await getLiveBuilderTemplate(templateId);
      if (!template || template.key !== CUSTOM_KEY) refuse("Choose a custom document template.");
      const read = readTemplateDocument(template.data, template.name);
      if (read.status !== "ok") refuse(`“${template.name}” can't be read — open it in the editor first.`);
      model = read.doc;
    }
    const title = field("title") ?? model.title;

    const studio = await buildMergeContext({ contactId, leadId, quoteId, userName: user.name });
    let snapshot: CustomDocSnapshot = { tokens: studio, items: [], vars: {} };
    if (quoteId) {
      const quote = await prisma.quote.findUnique({
        where: { id: quoteId },
        include: { items: true, fees: { orderBy: { sortOrder: "asc" } }, lead: { include: { product: true } }, contact: true, createdBy: true },
      });
      if (quote) {
        const ctx = buildQuoteContext(quote, await loadBillToFleet(prisma, quote.fleetId));
        snapshot = { tokens: combineTokens(studio, ctx.tokens), items: ctx.items, vars: ctx.vars };
      }
    }
    const frozen = documentSchema.parse({ ...freezeDocumentTokens(model, snapshot.tokens), title });

    const created = await prisma.docInstance.create({
      data: {
        title,
        contentJson: [], // legacy BlockNote column; unused by editor documents
        docModelJson: frozen as object,
        snapshotJson: snapshot as object,
        contactId,
        leadId,
        quoteId,
        builderTemplateId: templateId,
        createdById: user.id,
      },
    });
    await logAudit({
      action: "customdoc.created",
      summary: `Created document “${title}”${templateId ? " from a template" : ""}`,
      entityType: "DocInstance",
      entityId: created.id,
      contactId,
      leadId,
      user,
    });
    revalidatePath(STUDIO);
    return { redirectTo: editorPath(created.id) };
  });
}

/** Autosave from the editor. Only a draft, and only its own copy — never the template. */
export async function saveCustomDocument(id: string, doc: unknown): Promise<{ ok: boolean; error?: string }> {
  const parsed = documentSchema.safeParse(doc);
  if (!parsed.success) return { ok: false, error: "Invalid document structure" };
  const result = await asActionResult(async () => {
    const { row } = await editableDocument(id);
    if (!customDocumentEditable(row)) refuse("This document is finalised and can't be edited.");
    // Conditional on still being a draft: a save racing a Finalise must not
    // change the document after its PDF was filed.
    const { count } = await prisma.docInstance.updateMany({
      where: { id, status: "draft" },
      data: { docModelJson: parsed.data as object, title: parsed.data.title.trim() || row.title },
    });
    if (count === 0) refuse("This document is finalised and can't be edited.");
  });
  return result.error ? { ok: false, error: result.error } : { ok: true };
}

/** Render the document, file the PDF against its records, and lock it. */
export async function finaliseCustomDocument(id: string): Promise<{ ok: boolean; error?: string; pdfDocId?: string }> {
  let pdfDocId: string | undefined;
  const result = await asActionResult(async () => {
    const { user, row } = await editableDocument(id);
    if (!customDocumentEditable(row)) refuse("This document is already finalised.");
    const doc = parseDocument(row.docModelJson);
    if (!doc) refuse("This document can't be read, so it was not finalised.");
    const pdf = await renderModelToPdf(doc, renderSnapshot(row));

    const fileName = `${row.title}.pdf`;
    // ponytail: a Finalise that loses the race below leaves this blob unreferenced.
    const storedName = await saveFile(pdf, fileName, "application/pdf", row.tenantId);
    pdfDocId = await prisma.$transaction(async (tx) => {
      const filed = await tx.document.create({
        data: {
          fileName,
          storedName,
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
          contactId: row.contactId,
          quoteId: row.quoteId,
          // The document owns the filed PDF, as a Studio document does.
          tenantId: row.tenantId,
          tag: "generated-pdf",
          uploadedById: user.id,
        },
      });
      // Lock only the version that was rendered: a save that landed while the
      // PDF was being built changed `updatedAt`, and the PDF no longer matches.
      const { count } = await tx.docInstance.updateMany({
        where: { id, status: "draft", updatedAt: row.updatedAt },
        data: { status: "final", finalizedAt: new Date(), pdfDocId: filed.id },
      });
      if (count === 0) refuse("The document changed while it was being finalised. Try again.");
      return filed.id;
    });
    await logAudit({
      action: "customdoc.finalised",
      summary: `Finalised “${row.title}” — PDF filed in the repository`,
      entityType: "DocInstance",
      entityId: id,
      contactId: row.contactId,
      leadId: row.leadId,
      user,
    });
    revalidatePath(editorPath(id));
    revalidatePath(STUDIO);
  });
  return result.error ? { ok: false, error: result.error } : { ok: true, pdfDocId };
}

/**
 * "Convert to new editor": a Studio free-form template becomes a doc-editor
 * `custom` template. Converts the draft (what the Studio editor shows) and
 * never touches or deletes the original, so converting twice is harmless.
 */
export async function convertStudioTemplate(id: string) {
  return asActionResult(async () => {
    const user = await requirePermission("document_templates.manage");
    await requirePermission("docbuilder.manage");
    const source = await prisma.customDocTemplate.findUnique({ where: { id } });
    if (!source || source.deletedAt) refuse("That template isn't available.");
    const data = blockNoteToDocument(source.draftJson, source.name);
    const created = await prisma.docBuilderTemplate.create({
      data: { name: source.name, key: CUSTOM_KEY, data: data as object, createdById: user.id },
    });
    await logAudit({
      action: "customdoc.template.converted",
      summary: `Converted Studio template “${source.name}” to the document editor`,
      entityType: "DocBuilderTemplate",
      entityId: created.id,
      user,
    });
    revalidatePath(STUDIO);
    return { redirectTo: `/doc-editor/${created.id}` };
  });
}

/** Studio clauses, converted for insertion into the document editor (by value). */
export async function listClauseBlocks() {
  return withActingStaffScope(async () => {
    await requireAnyPermission("docbuilder.manage", "documents.manage", "document_templates.manage");
    const rows = await listStudioClauses();
    return rows.map((row) => ({ id: row.id, name: row.name, category: row.category, blocks: blockNoteToBlocks(row.contentJson) }));
  });
}
