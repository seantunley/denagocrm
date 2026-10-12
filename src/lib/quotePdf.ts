import "server-only";
import { htmlToPdf } from "@/lib/customDocs";
import { renderQuotePrintHtml } from "@/lib/quotePrintDocument";

/**
 * A quote as a PDF: the document the Print / PDF button serves, so it is exactly
 * what the quote's own Preview shows.
 *
 * Only renders. It changes nothing about the quote — which is why the
 * assistant's "here is the PDF of the draft I built" can use it without being
 * able to mark anything sent.
 *
 * TWO WAYS TO FAIL, kept apart because they call for opposite things:
 *
 *   "no_document"  there is nothing to render — the quote is gone, or no layout
 *                  resolves for it. Trying again will not make one: PERMANENT.
 *   "failed"       the document exists and turning it into a PDF did not work
 *                  this time — the browser would not start, it timed out, the
 *                  platform was short of memory. PASSING: worth another attempt.
 *
 * Treating both as "no PDF" closed a delivery for good on a hiccup.
 */
export type QuotePdf = { ok: true; pdf: Buffer } | { ok: false; reason: "no_document" | "failed" };

export async function quotePdf(quoteId: string): Promise<QuotePdf> {
  let html: string | null;
  try {
    html = await renderQuotePrintHtml({ quoteId });
  } catch (err) {
    // Reading the quote failed (the database, most likely) — not "there is no document".
    await logPdfError(err);
    return { ok: false, reason: "failed" };
  }
  if (!html) return { ok: false, reason: "no_document" };
  try {
    return { ok: true, pdf: await htmlToPdf(html) };
  } catch (err) {
    await logPdfError(err);
    return { ok: false, reason: "failed" };
  }
}

async function logPdfError(err: unknown): Promise<void> {
  const { logError } = await import("@/lib/errorLog");
  await logError("quote-pdf", err).catch(() => {});
}
