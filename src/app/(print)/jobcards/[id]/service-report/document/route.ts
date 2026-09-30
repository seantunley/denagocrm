import { notFound, redirect } from "next/navigation";
import { requireJobCardReadAccess } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { printToolbarHtml } from "@/lib/printToolbar";
import {
  builderLayoutFor,
  printHtmlResponse,
  printPathBlocked,
  renderServiceReportHtml,
} from "@/lib/deliveryServicePrint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The service report drawn from the single document editor — see the delivery
 * note's document route for why this is a route handler and repeats its guards.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return withActingStaffScope(async () => {
    const { id } = await context.params;
    const url = new URL(request.url);
    if (await printPathBlocked(url.pathname)) notFound();
    await requireJobCardReadAccess(id);

    const doc = await builderLayoutFor("service-report", url.searchParams.get("tpl"));
    if (!doc) redirect(`/jobcards/${encodeURIComponent(id)}/service-report${url.search}`);

    return printHtmlResponse(
      await renderServiceReportHtml({
        jobCardId: id,
        doc,
        toolbarHtml: printToolbarHtml(`/jobcards/${id}`, "Back to job card", request.headers.get("x-nonce")),
      }),
    );
  });
}
