import "server-only";
import { prisma } from "@/lib/db";
import { htmlToPdf } from "@/lib/customDocs";
import { renderQuotePrintHtml } from "@/lib/quotePrintDocument";

/**
 * The two halves of emailing a quote that every door shares: "Email quote" on
 * the quote itself (app/actions/quoteEmail.ts) and "Attach quote" in the email
 * composer (app/actions/emails.ts). One renderer, one rule for marking sent —
 * a quote emailed from either place ends up in the same state.
 */

/** The PDF the Print / PDF button serves, so the attachment is exactly what Preview showed. Null: it could not be made. */
export async function quotePdf(quoteId: string): Promise<Buffer | null> {
  const html = await renderQuotePrintHtml({ quoteId });
  if (!html) return null;
  try {
    return await htmlToPdf(html);
  } catch (err) {
    const { logError } = await import("@/lib/errorLog");
    await logError("quote-email-pdf", err);
    return null;
  }
}

/**
 * Called only AFTER the email has gone. Only a draft moves, and only the version
 * that was rendered: an edit saved while the PDF was being made bumps updatedAt,
 * and the quote then stays a draft rather than freezing a price the customer
 * never saw. True when this call is what made it sent.
 */
export async function markQuoteSentIfDraft(quote: { id: string; updatedAt: Date }): Promise<boolean> {
  const moved = await prisma.quote.updateMany({
    where: { id: quote.id, status: "draft", updatedAt: quote.updatedAt, deletedAt: null, signedAt: null, supersededAt: null },
    data: { status: "sent" },
  });
  return moved.count === 1;
}
