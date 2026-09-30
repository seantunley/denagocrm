import { notFound, redirect } from "next/navigation";
import { requireQuoteReadAccess } from "@/lib/permissions";
import { isQuoteBuilderDocKey, renderQuoteBuilderDocHtml } from "@/lib/quoteBuilderDocPrint";
import { printToolbarHtml } from "@/lib/printToolbar";
import { withActingStaffScope } from "@/lib/actingScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The invoice / sales agreement rendered from its PUBLISHED doc-editor layout.
 *
 * A route handler, like quotes/[id]/print, because renderDocumentHtml emits a
 * whole HTML document. The invoice and agreement pages send people here once the
 * layout is published; if it cannot render, this sends them back to the old page.
 * Binds the acting workspace for the same reason quotes/[id]/print does.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; key: string }> },
) {
  return withActingStaffScope(async () => {
    const { id, key } = await context.params;
    if (!isQuoteBuilderDocKey(key)) notFound();
    await requireQuoteReadAccess(id);

    const html = await renderQuoteBuilderDocHtml({
      quoteId: id,
      key,
      toolbarHtml: printToolbarHtml(`/quotes/${id}`, "Back to quote", request.headers.get("x-nonce")),
    });
    // Not published, or a layout that will not render: the old page prints it.
    // `legacy=1` stops that page sending the request straight back here.
    if (!html) redirect(`/quotes/${id}/${key}?legacy=1`);

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Pricing, customer and banking details — never cached by a proxy.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
