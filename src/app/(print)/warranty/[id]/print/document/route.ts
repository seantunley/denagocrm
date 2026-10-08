import { redirect } from "next/navigation";
import { requireWarrantyClaimReadAccess } from "@/lib/warrantyAccess";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { withActingStaffScope } from "@/lib/actingScope";
import { printToolbarHtml } from "@/lib/printToolbar";
import {
  loadWarrantyClaimForDoc,
  printableRecordLayout,
  renderRecordDocumentHtml,
} from "@/lib/docbuilder/leadWarrantyRecords";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The warranty claim, rendered from the single editor's PUBLISHED layout.
 *
 * The legacy page one level up redirects here only once the owner has pressed
 * Publish on the default warranty-claim template; until then this bounces back
 * to it. See the indemnity route for why this is a route handler.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withActingStaffScope(async () => {
    // The (print) layout's module guard does not run above a route handler.
    if (!(await isModuleEnabled("automotive"))) {
      return new Response("Not found", { status: 404 });
    }
    const { id } = await context.params;
    // The same guard as the legacy page: the claim's read rule (warranty grant
    // AND vehicle), not vehicle access alone.
    if (!(await requireWarrantyClaimReadAccess(id))) return new Response("Not found", { status: 404 });

    const doc = await printableRecordLayout("warranty-claim");
    if (!doc) redirect(`/warranty/${id}/print`);

    const bound = await loadWarrantyClaimForDoc(id);
    if (!bound) return new Response("Not found", { status: 404 });

    const html = await renderRecordDocumentHtml(
      doc,
      bound,
      printToolbarHtml("/warranty", "Back to warranty", request.headers.get("x-nonce")),
    );
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
