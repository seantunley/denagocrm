import { requireJobCardReadAccess } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { renderJobCardPrintHtml } from "@/lib/jobCardPrintDocument";
import { printToolbarHtml } from "@/lib/printToolbar";
import { withActingStaffScope } from "@/lib/actingScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The job card printed from its PUBLISHED single-editor layout.
 *
 * ../page.tsx sends people here only once the jobcard layout is published; until
 * then it renders its original layout and this route has nothing to serve. A
 * route handler, not a page, for the same reason as quotes/[id]/print/route.ts:
 * renderDocumentHtml emits the whole document. No layout runs above a route
 * handler, so the (print) layout's module guard and the acting workspace are
 * both established here.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withActingStaffScope(async () => {
    const { id } = await context.params;
    if (!(await isModuleEnabled("automotive"))) return new Response("Not found", { status: 404 });
    await requireJobCardReadAccess(id);

    const photos = new URL(request.url).searchParams.get("photos") === "1";
    const toggle = `/jobcards/${encodeURIComponent(id)}/print/document${photos ? "" : "?photos=1"}`;
    const toolbarHtml =
      printToolbarHtml(`/jobcards/${id}`, "Back to job card", request.headers.get("x-nonce")) +
      `<div class="doc-toolbar" style="padding:6px 14px;background:#0f172a;font-family:Helvetica,Arial,sans-serif;font-size:12px"><a href="${toggle}" style="color:#fdba74;text-decoration:none">${photos ? "✓ Condition photos included (remove)" : "Include condition photos"}</a></div>`;

    const html = await renderJobCardPrintHtml({ jobCardId: id, photos, toolbarHtml });
    if (!html) {
      // Unpublished again since the redirect — the original print page serves it.
      return Response.redirect(new URL(`/jobcards/${id}/print${photos ? "?photos=1" : ""}`, request.url), 303);
    }
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Customer details and pricing — never cached by a proxy.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
