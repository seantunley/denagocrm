import "server-only";
import fs from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import { buildQuoteContext, buildJobCardContext } from "@/lib/docbuilder/merge";
import { getCompanyProfile, companyTokens } from "@/lib/companyProfile";
import { htmlToPdf } from "@/lib/customDocs";
import { parseDocument, type DocumentModel } from "./model";
import { renderDocumentHtml, renderEmailHtml, type RenderCtx } from "./serialize";

/**
 * Fold the editable Company Profile in as {{company.*}} tokens, exactly as the
 * signing path's bindCtx() does — otherwise the builder preview/export/PDF path
 * renders literal {{company.name}} placeholders in the FROM card and footer.
 * Record-specific tokens still win on any overlap.
 */
async function withCompany(ctx: RenderCtx): Promise<RenderCtx> {
  if (!ctx) return ctx;
  return { ...ctx, tokens: { ...companyTokens(await getCompanyProfile()), ...ctx.tokens } };
}

let logoCache: string | null | undefined;
function logoDataUri(): string | undefined {
  if (logoCache !== undefined) return logoCache ?? undefined;
  try {
    const buf = fs.readFileSync(path.join(process.cwd(), "public", "branding", "denago-logo-email.png"));
    logoCache = `data:image/png;base64,${buf.toString("base64")}`;
  } catch { logoCache = null; }
  return logoCache ?? undefined;
}

type Resolved = { doc: DocumentModel; ctx: RenderCtx; title: string; quoteId: string | null; jobCardId: string | null; contactId: string | null };

/** Load a template + bind it to a quote/job card (shared by PDF and export). */
async function resolve(templateId: string, quoteId?: string | null, jobCardId?: string | null): Promise<Resolved | null> {
  const tpl = await getBuilderTemplate(templateId);
  if (!tpl) return null;
  const doc = parseDocument(tpl.data);
  if (!doc) return null;
  let ctx: RenderCtx = null;
  let title = doc.title || tpl.name;
  let qId: string | null = null, jId: string | null = null, contactId: string | null = null;
  if (quoteId) {
    const q = await prisma.quote.findUnique({
      where: { id: quoteId },
      include: { items: true, lead: { include: { product: true } }, contact: true, createdBy: true },
    });
    if (q) { ctx = await withCompany(buildQuoteContext(q)); title = `${doc.title} — Q-${q.number}`; qId = q.id; contactId = q.contactId; }
  } else if (jobCardId) {
    const jc = await prisma.jobCard.findUnique({
      where: { id: jobCardId },
      include: { items: true, vehicle: true, contact: true, technician: true },
    });
    if (jc) { ctx = await withCompany(buildJobCardContext(jc)); title = `${doc.title} — Job #${jc.number}`; jId = jc.id; contactId = jc.contactId; }
  }
  return { doc, ctx, title, quoteId: qId, jobCardId: jId, contactId };
}

/**
 * Render a doc-editor template to a multi-page (unsigned) PDF, optionally bound
 * to a quote or job card. Sealing/tamper-proofing happens only in the signing
 * flow after a recipient actually signs — never here.
 */
export async function generateDocEditorPdf(opts: {
  templateId: string; quoteId?: string | null; jobCardId?: string | null;
}): Promise<{ buffer: Buffer; title: string; quoteId: string | null; jobCardId: string | null; contactId: string | null } | null> {
  const r = await resolve(opts.templateId, opts.quoteId, opts.jobCardId);
  if (!r) return null;
  const html = renderDocumentHtml(r.doc, r.ctx, logoDataUri());
  const buffer = await htmlToPdf(html);
  return { buffer, title: r.title, quoteId: r.quoteId, jobCardId: r.jobCardId, contactId: r.contactId };
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
