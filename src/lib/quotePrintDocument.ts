import "server-only";
import { prisma } from "@/lib/db";
import { getBuilderTemplate, defaultBuilderTemplateId } from "@/lib/docbuilder/store";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import { renderDocumentHtml } from "@/lib/doceditor/serialize";
import { bindCtx, logoDataUri, signedFieldStamps } from "@/lib/signing/render";

/**
 * The printed quote, rendered from the SAME document the customer signs.
 *
 * There were three quotation renderers. QuotePrintDoc drew its own layout from
 * a DocTemplateRecord; the signing envelope rendered a DocBuilderTemplate; the
 * react-pdf QuoteDoc had no template at all. Two of them had editors, in two
 * different places, and neither could see the other's work — so the printed
 * quote and the signed quote could disagree about terms, branding and layout
 * with nothing to warn you. Document Studio said as much: "other document types
 * remain on their existing production renderers until each builder layout
 * reaches visual parity."
 *
 * This is the quote reaching it. One template, edited in one place, behind
 * print, PDF and signature alike.
 */
export async function renderQuotePrintHtml(opts: {
  quoteId: string;
  /** Preview a specific builder template instead of the quote default. */
  templateId?: string | null;
  toolbarHtml?: string;
}): Promise<string | null> {
  const templateId = opts.templateId ?? (await defaultBuilderTemplateId("quote"));
  if (!templateId) return null;
  const template = await getBuilderTemplate(templateId);
  if (!template) return null;
  // A legacy row must stop here rather than fall through to a blank layout —
  // this is the document the customer is handed.
  const read = readTemplateDocument(template.data, template.name);
  if (read.status !== "ok") return null;

  const ctx = await bindCtx(opts.quoteId, null);

  // A signed quote prints what was actually signed: the signatures land at the
  // field positions the template placed, from the completed request. An unsigned
  // one hides the empty dashed boxes — they are a signing affordance, and there
  // is nothing to tap on paper.
  const request = await prisma.signatureRequest.findFirst({
    where: { quoteId: opts.quoteId, deletedAt: null, status: "completed" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const stampedFields = request ? await signedFieldStamps(request.id, "") : undefined;

  return renderDocumentHtml(read.doc, ctx, logoDataUri(), {
    hideOverlays: !stampedFields?.length,
    stampedFields: stampedFields?.length ? stampedFields : undefined,
    toolbarHtml: opts.toolbarHtml,
  });
}

/** Screen-only Print / Back bar. Hidden by @media print — see renderDocumentHtml. */
export function printToolbarHtml(backHref: string, backLabel: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return `<div class="doc-toolbar" style="position:sticky;top:0;z-index:50;display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:10px 14px;background:#0f172a;font-family:Helvetica,Arial,sans-serif">
    <a href="${esc(backHref)}" style="color:#cbd5e1;text-decoration:none;font-size:13px;margin-right:auto">&larr; ${esc(backLabel)}</a>
    <button type="button" onclick="window.print()" style="background:#ea580c;color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer">Print / Save PDF</button>
  </div>`;
}
