import { requireQuoteReadAccess } from "@/lib/permissions";
import { renderQuotePrintHtml, printToolbarHtml } from "@/lib/quotePrintDocument";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The printable quote.
 *
 * A route handler rather than a React page, because renderDocumentHtml emits a
 * complete document — the same one the PDF pipeline and the signing envelope
 * render. Serving it whole is what makes the three agree; wrapping it in the
 * app's own <body> would mean re-implementing its layout in React, which is the
 * duplication this replaced.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  await requireQuoteReadAccess(id);

  // ?tpl= previews a specific builder template — used by the Document Studio
  // preview links. It selects a LAYOUT, never a different quote's data.
  const templateId = new URL(request.url).searchParams.get("tpl");

  const html = await renderQuotePrintHtml({
    quoteId: id,
    templateId,
    toolbarHtml: printToolbarHtml(`/quotes?edit=${id}`, "Back to quote"),
  });
  if (!html) {
    return new Response(
      "This quote has no printable layout yet. Open Document Studio and set a default quote document.",
      { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // A quote carries pricing and customer details — never cached by a proxy.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
