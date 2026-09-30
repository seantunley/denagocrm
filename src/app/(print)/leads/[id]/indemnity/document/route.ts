import { redirect } from "next/navigation";
import { requireLeadReadAccess } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { printToolbarHtml } from "@/lib/printToolbar";
import {
  loadLeadForDoc,
  printableRecordLayout,
  renderRecordDocumentHtml,
} from "@/lib/docbuilder/leadWarrantyRecords";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The test-drive indemnity, rendered from the single editor's PUBLISHED layout.
 *
 * The legacy page one level up redirects here only once the owner has pressed
 * Publish on the default indemnity template; until then this bounces back to it.
 * Both ask printableRecordLayout(), so they cannot disagree. A route handler, not
 * a page, for the reason the quote print route gives: renderDocumentHtml emits a
 * whole document, and nothing establishes the acting workspace above a route
 * handler, hence withActingStaffScope.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withActingStaffScope(async () => {
    const { id } = await context.params;
    // The same guard as the legacy page.
    await requireLeadReadAccess(id);

    const doc = await printableRecordLayout("indemnity");
    if (!doc) redirect(`/leads/${id}/indemnity`);

    const bound = await loadLeadForDoc(id);
    if (!bound) return new Response("Not found", { status: 404 });

    const html = await renderRecordDocumentHtml(
      doc,
      bound,
      printToolbarHtml(`/leads/${id}`, "Back to lead", request.headers.get("x-nonce")),
    );
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Customer contact details — never cached by a proxy.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
