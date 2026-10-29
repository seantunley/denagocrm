import { notFound, redirect } from "next/navigation";
import { requireAnyPermission, requireContactReadAccess } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { printToolbarHtml } from "@/lib/printToolbar";
import { renderStatementDocHtml } from "@/lib/statementDocPrint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A customer's statement, printed from the document editor — the published
 * Statement layout, or the published invoice converted (statementDocPrint.ts).
 *
 * The page one level up sends people here when there is such a layout; this
 * sends them back (?legacy=1) when there is not, or when the viewer cannot see
 * every invoice on the account (the page explains that). A route handler, as
 * for the invoice: renderDocumentHtml emits a whole document, and nothing above
 * a route handler binds the acting workspace, hence withActingStaffScope.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withActingStaffScope(async () => {
    const { id } = await context.params;
    // The same gates as the page: this customer, and invoices at all.
    const user = await requireContactReadAccess(id);
    await requireAnyPermission("quotes.view_all", "quotes.view_owned");

    const result = await renderStatementDocHtml({
      account: "contact",
      id,
      user,
      toolbarHtml: printToolbarHtml(`/contacts/${id}`, "Back to customer", request.headers.get("x-nonce")),
    });
    if (result.kind === "missing") notFound();
    if (result.kind !== "ok") redirect(`/contacts/${id}/statement?legacy=1`);
    return new Response(result.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Balances, payments and banking details — never cached by a proxy.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
