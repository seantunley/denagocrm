import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireQuoteReadAccess } from "@/lib/permissions";
import PrintActions from "@/components/PrintActions";
import PrintDocShell, { ItemsTable, InfoBlock } from "@/components/print/PrintDocShell";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { contactName, formatDate } from "@/lib/format";
import { documentTotals, feeRows } from "@/lib/pricing";

export default async function InvoicePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tpl?: string }>;
}) {
  const { id } = await params;
  await requireQuoteReadAccess(id);
  const { tpl: tplId } = await searchParams;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { items: true, fees: { orderBy: { sortOrder: "asc" } }, contact: true, lead: true },
  });
  if (!quote) notFound();
  const tpl = await getDocTemplate("invoice", tplId);
  // Fees and delivery are part of what the customer pays; the subtotal is not.
  const totals = documentTotals(quote);
  const customer = quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "";

  return (
    <>
      <PrintActions backHref={`/quotes/${quote.id}`} backLabel="Back to quote" />
      <PrintDocShell
        template={tpl}
        title="Invoice"
        number={`INV-${quote.number}`}
        meta={[
          `Date: ${formatDate(quote.invoicedAt ?? new Date())}`,
          `Reference: Q-${quote.number}`,
          customer ? `Billed to: ${customer}` : "",
        ].filter(Boolean)}
        parties={{ left: "Received by · Date", right: null }}
        bodySection="banking"
        bodyTitle="Payment details"
      >
        <div className="grid grid-cols-2 gap-4 mb-6">
          <InfoBlock
            title="Billed to"
            accent
            lines={[
              customer,
              quote.contact?.phone ?? quote.lead?.phone,
              quote.contact?.email ?? quote.lead?.email,
            ]}
          />
          <InfoBlock
            title="Invoice details"
            lines={[`Invoice INV-${quote.number}`, `Quote Q-${quote.number}`, `Status: ${quote.status}`]}
          />
        </div>
        <ItemsTable rows={[...quote.items, ...feeRows(quote.fees)]} showPrices totals={totals} />
        {tpl.sections.terms !== false && tpl.terms && (
          <div className="rounded-lg bg-slate-50 px-4 py-3 mt-6 no-break">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
              Payment terms
            </p>
            <p className="text-xs text-slate-600 whitespace-pre-wrap">{tpl.terms}</p>
          </div>
        )}
      </PrintDocShell>
    </>
  );
}
