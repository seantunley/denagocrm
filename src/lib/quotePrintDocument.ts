import "server-only";
import { prisma } from "@/lib/db";
import { getBuilderTemplate, defaultBuilderTemplateId } from "@/lib/docbuilder/store";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import { parseDocument } from "@/lib/doceditor/model";
import { renderDocumentHtml } from "@/lib/doceditor/serialize";
import { attachQuoteFooterToFinalScreenSheet } from "@/lib/quoteFooterSheet";
import { bindCtx, logoDataUri, signedFieldStamps } from "@/lib/signing/render";
import { parseFrozenBrand } from "@/lib/signing/frozenBrand";

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
  // A signed quote prints what was actually signed: the signatures land at the
  // field positions the SNAPSHOT placed, from the completed request. An unsigned
  // one hides the empty dashed boxes — they are a signing affordance, and there
  // is nothing to tap on paper.
  //
  // Looked up BEFORE the context is bound, which is load-bearing rather than
  // tidy: the context carries the {{company.*}} tokens, and a signed quote must
  // bind the brand FROZEN on the request rather than whatever the workspace is
  // called today. Bound after, this function printed the current brand above
  // signatures that were given to a differently-named company.
  const request = await prisma.signatureRequest.findFirst({
    where: { quoteId: opts.quoteId, deletedAt: null, status: "completed" },
    orderBy: { createdAt: "desc" },
    select: { id: true, snapshotJson: true, brandJson: true },
  });
  const frozen = request ? parseFrozenBrand(request.brandJson) : null;
  const ctx = await bindCtx(opts.quoteId, null, frozen);

  // The signed quote prints its own frozen document, NOT the current default
  // template. Resolving the live template here meant that editing the quote
  // layout in Document Studio retroactively changed every already-signed quote:
  // the customer was handed terms, branding and clauses they had never seen,
  // while the stamped signatures still sat at coordinates the OLD layout chose —
  // so the signatures could land in the middle of text that moved under them.
  // SignatureRequest.snapshotJson is the document the signature is evidence of;
  // renderRequestDocHtml() already prints from it for the signing hub.
  //
  // ?tpl= still wins: that is Document Studio previewing a LAYOUT against real
  // data, and it must show the layout that was asked for.
  if (!opts.templateId && request) {
    const signedDoc = parseDocument(request.snapshotJson);
    if (signedDoc) {
      const stamps = await signedFieldStamps(request.id, "");
      const html = renderDocumentHtml(signedDoc, ctx, frozen?.logoUrl ?? logoDataUri(), {
        hideOverlays: !stamps.length,
        stampedFields: stamps.length ? stamps : undefined,
        toolbarHtml: opts.toolbarHtml,
      });
      return attachQuoteFooterToFinalScreenSheet(html);
    }
    // An unparseable snapshot falls through to the template below rather than
    // returning nothing — a printable quote beats a 404.
  }

  const templateId = opts.templateId ?? (await defaultBuilderTemplateId("quote"));
  if (!templateId) return null;
  const template = await getBuilderTemplate(templateId);
  if (!template) return null;
  // A legacy row must stop here rather than fall through to a blank layout —
  // this is the document the customer is handed.
  const read = readTemplateDocument(template.data, template.name);
  if (read.status !== "ok") return null;

  const stampedFields = request ? await signedFieldStamps(request.id, "") : undefined;

  const html = renderDocumentHtml(read.doc, ctx, logoDataUri(), {
    hideOverlays: !stampedFields?.length,
    stampedFields: stampedFields?.length ? stampedFields : undefined,
    toolbarHtml: opts.toolbarHtml,
  });
  return attachQuoteFooterToFinalScreenSheet(html);
}

/** Screen-only Print / Back bar. Hidden by @media print — see renderDocumentHtml. */
