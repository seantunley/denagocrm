import { requireQuoteReadAccess } from "@/lib/permissions";
import { renderQuotePrintHtml, printToolbarHtml } from "@/lib/quotePrintDocument";
import { withActingStaffScope } from "@/lib/actingScope";

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
 *
 * ── IT BINDS THE ACTING WORKSPACE, AND MUST ─────────────────────────────────
 *
 * This is a ROUTE HANDLER, so no layout runs above it and nothing establishes
 * the acting workspace - `(app)`'s layout is what does that for an ordinary
 * page, and print documents deliberately live outside it.
 *
 * Three hops down, renderQuotePrintHtml -> bindCtx -> loadBillToFleet reads that
 * scope SYNCHRONOUSLY through activeTenantPredicate. Under
 * TENANT_ENFORCEMENT=enforce a sync read with no scope THROWS rather than
 * returning an empty predicate, and nothing here catches it, so the response is
 * a bare 500.
 *
 * It showed only on FLEET quotes: loadBillToFleets returns early when the quote
 * names no fleet, so an ordinary quote never reaches the predicate. Printing
 * worked everywhere else, which is why this read as a fleet bug rather than a
 * tenancy one.
 *
 * The wrapper never widens - an already-bound scope wins, and an unresolvable
 * session runs bare so requireQuoteReadAccess below still fails closed.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withActingStaffScope(async () => {
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
  });
}
