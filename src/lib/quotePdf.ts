import "server-only";
import { htmlToPdf } from "@/lib/customDocs";
import { renderQuotePrintHtml } from "@/lib/quotePrintDocument";

/**
 * A quote as a PDF: the document the Print / PDF button serves, so it is exactly
 * what the quote's own Preview shows. Null: it could not be made.
 *
 * Only renders. It changes nothing about the quote — which is why the
 * assistant's "here is the PDF of the draft I built" can use it without being
 * able to mark anything sent.
 */
export async function quotePdf(quoteId: string): Promise<Buffer | null> {
  const html = await renderQuotePrintHtml({ quoteId });
  if (!html) return null;
  try {
    return await htmlToPdf(html);
  } catch (err) {
    const { logError } = await import("@/lib/errorLog");
    await logError("quote-pdf", err);
    return null;
  }
}
