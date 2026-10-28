import { notFound, redirect } from "next/navigation";
import { requireAnyPermission, requireRoute } from "@/lib/permissions";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { withActingStaffScope } from "@/lib/actingScope";
import { printToolbarHtml } from "@/lib/printToolbar";
import { renderStatementDocHtml } from "@/lib/statementDocPrint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A fleet account's statement, printed from the document editor. The contact
 * route explains the shape; this adds the fleet screens' own gates — the
 * /fleets rule, and the module fleets belong to (the print layout applies it to
 * the page; nothing applies it to a route handler).
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withActingStaffScope(async () => {
    const { id } = await context.params;
    await requireModuleEnabled("automotive");
    const user = await requireRoute("/fleets");
    await requireAnyPermission("quotes.view_all", "quotes.view_owned");

    const result = await renderStatementDocHtml({
      account: "fleet",
      id,
      user,
      toolbarHtml: printToolbarHtml(`/fleets/${id}`, "Back to fleet", request.headers.get("x-nonce")),
    });
    if (result.kind === "missing") notFound();
    if (result.kind !== "ok") redirect(`/fleets/${id}/statement?legacy=1`);
    return new Response(result.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
