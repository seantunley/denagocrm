import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireQuoteReadAccess } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { loadBillToFleet } from "@/lib/quoteBillTo";
import PrintActions from "@/components/PrintActions";
import QuotePrintDoc from "@/components/print/QuotePrintDoc";
import { getDocTemplate } from "@/lib/docTemplateStore";

/**
 * The page behind "Print / PDF" on a quote.
 *
 * ── WHY THIS FILE CAME BACK ─────────────────────────────────────────────────
 *
 * It was deleted on 2 August in 418bb1d4 (a signing-blockers commit) and its
 * three callers were left pointing at it: the quote editor's Print / PDF button,
 * the quotes list row action, and the document-template preview
 * (`?tpl=` — which is why the template parameter is still read here). Print /
 * PDF has been dead for every quote since, not only fleet ones.
 *
 * Restored rather than re-pointed at one of the sibling documents: `invoice`,
 * `agreement` and `delivery-note` are each a specific document with its own
 * legal meaning, and this is the plain quote. Sending someone to an invoice
 * when they asked to print a quote would be worse than the 404.
 *
 * ── WHY IT BINDS THE WORKSPACE ITSELF ───────────────────────────────────────
 *
 * Print documents live in the `(print)` route group, whose layout deliberately
 * does NOT wrap them in the `(app)` chrome — and `(app)`'s layout is what
 * establishes the acting workspace for an ordinary page. So a print page starts
 * with no scope, while `loadBillToFleet` below reads it synchronously through
 * `activeTenantPredicate`; under TENANT_ENFORCEMENT=enforce that throws rather
 * than returning an empty predicate, and the reader would be a 500 with nothing
 * in the tenant's System Log.
 *
 * The wrapper never widens: an already-bound scope wins, and an unresolvable
 * session runs bare so `requireQuoteReadAccess` below still fails closed.
 */
export default async function QuotePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tpl?: string }>;
}) {
  return withActingStaffScope(async () => {
    const { id } = await params;
    await requireQuoteReadAccess(id);
    const { tpl } = await searchParams;
    const quote = await prisma.quote.findUnique({
      where: { id },
      include: {
        items: true,
        fees: { orderBy: { sortOrder: "asc" } },
        lead: { include: { product: true } },
        contact: true,
        createdBy: true,
      },
    });
    if (!quote) notFound();

    // Resolved and tenant-checked here, because QuotePrintDoc requires it rather
    // than accepting undefined — a fleet quote must print the account it is
    // billed to, not the manager's personal name.
    const fleet = await loadBillToFleet(prisma, quote.fleetId);

    return (
      <>
        <PrintActions backHref={`/quotes/${quote.id}`} backLabel="Back to quote" />
        <QuotePrintDoc quote={quote} fleet={fleet} template={await getDocTemplate("quote", tpl)} />
      </>
    );
  });
}
