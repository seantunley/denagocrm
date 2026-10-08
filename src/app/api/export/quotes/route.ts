import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { loadBillToFleets } from "@/lib/quoteBillTo";
import { quoteCsv } from "@/lib/quoteList";
import { quoteListFilter } from "@/lib/quoteListQuery";
import { getRegionalSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CSV of the quotes list — EVERY quote matching the current search and status,
 * not just the visible page.
 *
 * Gate: exactly the quotes page's own (quotes.view_all or quotes.view_owned),
 * and rows are RBAC-scoped by the same quoteListFilter the page uses, so this
 * can never hand anyone a quote the list would not show them. There is no
 * separate quotes.export permission; the export is audit-logged instead, like
 * the other exports.
 *
 * A route handler, so no (app) layout binds the acting workspace — bind it here,
 * as the print route does, or loadBillToFleets fails closed on fleet quotes.
 */
export async function GET(request: NextRequest) {
  return withActingStaffScope(async () => {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await hasAnyPermission(user, "quotes.view_all", "quotes.view_owned"))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const params = request.nextUrl.searchParams;
    const status = params.get("status");
    const { where } = await quoteListFilter(user, { q: params.get("q"), status });
    const quotes = await prisma.quote.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        items: true,
        fees: true,
        lead: { select: { title: true, name: true, email: true, phone: true } },
        contact: true,
        createdBy: { select: { name: true } },
      },
    });
    const [fleets, regional] = await Promise.all([
      loadBillToFleets(prisma, quotes.map((quote) => quote.fleetId)),
      // The workspace's currency and calendar (Settings → Quotes).
      getRegionalSettings(),
    ]);
    const csv = quoteCsv(quotes, fleets, regional);

    // Counts and the status filter only — the search text can be a customer's
    // name, which does not belong in a log line.
    await logAudit({
      action: "quotes.exported",
      summary: `Exported ${quotes.length} quote${quotes.length === 1 ? "" : "s"} to CSV`,
      entityType: "Quote",
      user: { id: user.id, name: user.name },
      source: "app",
      metadata: { rowCount: quotes.length, status: status || null, searched: Boolean(params.get("q")?.trim()) },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="quotes-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  });
}
