import { notFound, redirect } from "next/navigation";
import { requireQuoteReadAccess } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { withActingStaffScope } from "@/lib/actingScope";
import { printToolbarHtml } from "@/lib/printToolbar";
import {
  builderLayoutFor,
  printHtmlResponse,
  printPathBlocked,
  renderDeliveryNoteHtml,
} from "@/lib/deliveryServicePrint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The delivery note drawn from the single document editor. A route handler, as
 * for the quote, because renderDocumentHtml emits a complete document.
 *
 * The page at ../ sends people here only once the delivery layout is published
 * (or Document Studio previews one). No layout runs above a route handler, so
 * the acting workspace, the module guard and the access check are all repeated
 * here rather than assumed.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withActingStaffScope(async () => {
    const { id } = await context.params;
    const url = new URL(request.url);
    if (!(await isModuleEnabled("automotive")) || (await printPathBlocked(url.pathname))) notFound();
    await requireQuoteReadAccess(id);

    const doc = await builderLayoutFor("delivery", url.searchParams.get("tpl"));
    // Not (or no longer) published: the page renders the fixed layout.
    if (!doc) redirect(`/quotes/${encodeURIComponent(id)}/delivery-note${url.search}`);

    const embedded = url.searchParams.get("embed") === "1";
    return printHtmlResponse(
      await renderDeliveryNoteHtml({
        quoteId: id,
        doc,
        requestedRuns: url.searchParams.get("runs") ?? undefined,
        // The review screen iframes the note; its own toolbar would be nested chrome.
        toolbarHtml: embedded ? undefined : printToolbarHtml("/deliveries", "Back to deliveries", request.headers.get("x-nonce")),
      }),
    );
  });
}
