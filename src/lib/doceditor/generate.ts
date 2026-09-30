import "server-only";
import { prisma } from "@/lib/db";
import { getBuilderTemplate, getLiveBuilderTemplate } from "@/lib/docbuilder/store";
import { buildQuoteContext, buildJobCardContext } from "@/lib/docbuilder/merge";
import { loadBillToFleet } from "@/lib/quoteBillTo";
import { getCompanyProfile, companyTokens } from "@/lib/companyProfile";
import { htmlToPdf } from "@/lib/customDocs";
import { type DocumentModel } from "./model";
import { readTemplateDocument } from "./legacy";
import { renderDocumentHtml, renderEmailHtml, type RenderCtx } from "./serialize";
import { defaultLogoDataUri as logoDataUri, documentLogo, embedDocImages, liveGlobalTokens } from "./renderGlobals";

/**
 * Fold the editable Company Profile in as {{company.*}} tokens, exactly as the
 * signing path's bindCtx() does — otherwise the builder preview/export/PDF path
 * renders literal {{company.name}} placeholders in the FROM card and footer.
 * Because these tokens don't depend on a bound record, they are resolved even when
 * NO quote/job card is bound (list preview / "No record" export), where ctx would
 * otherwise be null. Record-specific tokens still win on any overlap.
 */
async function withCompany(ctx: RenderCtx, tenantId?: string | null): Promise<RenderCtx> {
  const profile = await getCompanyProfile();
  const company = { ...(await liveGlobalTokens()), ...companyTokens(profile) };
  const logo = await documentLogo(profile.logoUrl, tenantId);
  // Unbound: carry company tokens only, but mark bound:false so conditionals/showIf
  // columns render as the placeholder layout rather than evaluating an empty scope.
  if (!ctx) return { tokens: company, items: [], vars: {}, bound: false, logo };
  return { ...ctx, tokens: { ...company, ...ctx.tokens }, bound: true, logo };
}

export type Resolved = { doc: DocumentModel; ctx: RenderCtx; title: string; quoteId: string | null; jobCardId: string | null; contactId: string | null };

/**
 * Load a template + bind it to a quote/job card (shared by PDF and export).
 * EXPORTED so the signing path can fingerprint the RESOLVED artefact ({doc, ctx}
 * — recipients, fields AND the bound quote/job-card/contact values) without
 * paying for a full PDF render. Hashing only the template model + record IDs
 * misses the case where a quote's prices/customer details change under the same
 * id: the resolved ctx here does change, so a fingerprint over it does too.
 */
export async function resolveDocEditorContent(templateId: string, quoteId?: string | null, jobCardId?: string | null): Promise<Resolved | null> {
  return resolve(templateId, quoteId, jobCardId);
}

/** Render an already-resolved template to a multi-page (unsigned) PDF. */
export async function renderResolvedToPdf(r: Resolved): Promise<{ buffer: Buffer; title: string; quoteId: string | null; jobCardId: string | null; contactId: string | null }> {
  const html = renderDocumentHtml(r.doc, r.ctx, logoDataUri());
  const buffer = await htmlToPdf(html);
  return { buffer, title: r.title, quoteId: r.quoteId, jobCardId: r.jobCardId, contactId: r.contactId };
}

/** Load a template + bind it to a quote/job card (shared by PDF and export). */
async function resolve(templateId: string, quoteId?: string | null, jobCardId?: string | null, live = false): Promise<Resolved | null> {
  // `live`: a document being filed against a record renders the PUBLISHED
  // version; previews and the editor's own exports render the draft.
  const tpl = live ? await getLiveBuilderTemplate(templateId) : await getBuilderTemplate(templateId);
  if (!tpl) return null;
  // Either failure ends the same way here — no PDF, a 404 from the route. This
  // path only reads, so there is nothing to protect beyond not rendering a
  // document we could not fully understand.
  const read = readTemplateDocument(tpl.data, tpl.name);
  if (read.status !== "ok") return null;
  const doc = await embedDocImages(read.doc, tpl.tenantId);
  let ctx: RenderCtx = null;
  let title = doc.title || tpl.name;
  let qId: string | null = null, jId: string | null = null, contactId: string | null = null;
  if (quoteId) {
    const q = await prisma.quote.findUnique({
      where: { id: quoteId },
      include: { items: true, fees: { orderBy: { sortOrder: "asc" } }, lead: { include: { product: true } }, contact: true, createdBy: true },
    });
    // Tenant-scoped fleet lookup, not an include — Quote.fleetId has no FK.
    if (q) { ctx = buildQuoteContext(q, await loadBillToFleet(prisma, q.fleetId)); title = `${doc.title} — Q-${q.number}`; qId = q.id; contactId = q.contactId; }
  } else if (jobCardId) {
    const jc = await prisma.jobCard.findUnique({
      where: { id: jobCardId },
      include: { items: true, vehicle: true, contact: true, technician: true },
    });
    if (jc) { ctx = buildJobCardContext(jc); title = `${doc.title} — Job #${jc.number}`; jId = jc.id; contactId = jc.contactId; }
  }
  // Fold in company tokens once — including the unbound case (ctx still null), so the
  // record-independent brand tokens resolve in list previews and "No record" exports.
  ctx = await withCompany(ctx);
  return { doc, ctx, title, quoteId: qId, jobCardId: jId, contactId };
}

/**
 * Render a doc-editor template to a multi-page (unsigned) PDF, optionally bound
 * to a quote or job card. Sealing/tamper-proofing happens only in the signing
 * flow after a recipient actually signs — never here.
 */
export async function generateDocEditorPdf(opts: {
  templateId: string; quoteId?: string | null; jobCardId?: string | null; live?: boolean;
}): Promise<{ buffer: Buffer; title: string; quoteId: string | null; jobCardId: string | null; contactId: string | null } | null> {
  const r = await resolve(opts.templateId, opts.quoteId, opts.jobCardId, opts.live);
  if (!r) return null;
  return renderResolvedToPdf(r);
}

/**
 * A stand-alone document (a custom document, not a template) as print HTML,
 * with the record snapshot it was frozen with — null when it is linked to
 * nothing. Same company tokens, workspace logo and renderer as a generated
 * template, and — like every other render path — uploaded images embedded
 * BEFORE rendering: the stored files are private, and the PDF renderer has no
 * session to fetch them with.
 *
 * `tenantId` is the document's OWN workspace. Images are embedded only if they
 * belong to it, so a ref pasted in from another workspace is dropped, not
 * printed. A document with no owner falls back to the acting workspace.
 */
export async function renderCustomDocumentHtml(doc: DocumentModel, snapshot: RenderCtx, tenantId: string | null): Promise<string> {
  const embedded = await embedDocImages(doc, tenantId ?? undefined);
  return renderDocumentHtml(embedded, await withCompany(snapshot, tenantId), logoDataUri());
}

/** {@link renderCustomDocumentHtml}, as a PDF — used by Finalise and the preview route. */
export async function renderModelToPdf(doc: DocumentModel, snapshot: RenderCtx, tenantId: string | null): Promise<Buffer> {
  return htmlToPdf(await renderCustomDocumentHtml(doc, snapshot, tenantId));
}

export type ExportFormat = "html" | "email" | "doc";

/** Export a template as static HTML, email-safe HTML, or a Word-openable .doc. */
export async function generateDocEditorExport(opts: { templateId: string; quoteId?: string | null; format: ExportFormat }):
  Promise<{ content: string; title: string; mime: string; ext: string } | null> {
  const r = await resolve(opts.templateId, opts.quoteId);
  if (!r) return null;
  if (opts.format === "email") {
    return { content: renderEmailHtml(r.doc, r.ctx, logoDataUri()), title: r.title, mime: "text/html; charset=utf-8", ext: "html" };
  }
  const html = renderDocumentHtml(r.doc, r.ctx, logoDataUri());
  if (opts.format === "doc") {
    // HTML that Word opens natively — a pragmatic .doc export.
    return { content: html, title: r.title, mime: "application/msword", ext: "doc" };
  }
  return { content: html, title: r.title, mime: "text/html; charset=utf-8", ext: "html" };
}
