import { notFound, redirect } from "next/navigation";
import { builderDocRedirect } from "@/lib/docbuilder/quoteDocs";
import { publishedBuilderTemplateFor } from "@/lib/docbuilder/published";
import { prisma } from "@/lib/db";
import { requireQuoteReadAccess } from "@/lib/permissions";
import PrintActions from "@/components/PrintActions";
import PrintDocShell, { ItemsTable, InfoBlock } from "@/components/print/PrintDocShell";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getRegionalSettings } from "@/lib/settings";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { formatDate } from "@/lib/format";
import { documentTotals, feeRows, includedLines } from "@/lib/pricing";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { formatInvoiceNumber } from "@/lib/invoiceNumber";

export default async function InvoicePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tpl?: string; legacy?: string }>;
}) {
  const { id } = await params;
  await requireQuoteReadAccess(id);
  const search = await searchParams;
  const tplId = search.tpl;
  // Once the invoice layout is PUBLISHED in the document editor, it prints from
  // there; until then, this page prints exactly as it always has.
  const builderHref = await builderDocRedirect(id, "invoice", search, () => publishedBuilderTemplateFor("invoice"));
  if (builderHref) redirect(builderHref);
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { items: true, fees: { orderBy: { sortOrder: "asc" } }, contact: true, lead: true },
  });
  if (!quote) notFound();
  // The company this document is FROM. getCompanyProfile now inherits the
  // platform-set tenant brand when the tenant has not filled in its own profile.
  const company = await getCompanyProfile();
  const regional = await getRegionalSettings();
  const tpl = await getDocTemplate("invoice", tplId);
  // Fees and delivery are part of what the customer pays; the subtotal is not.
  const totals = documentTotals(quote);
  // An INVOICE is the document where getting this wrong matters most: it names
  // who owes the money and carries the VAT number the recipient claims against.
  const billTo = quoteBillTo(quote, await loadBillToFleet(prisma, quote.fleetId));
  const customer = billTo.name;

  return (
    <>
      <PrintActions backHref={`/quotes/${quote.id}`} backLabel="Back to quote" />
      <PrintDocShell
        company={company}
        template={tpl}
        title="Invoice"
        number={formatInvoiceNumber(quote.invoiceNumber)}
        meta={[
          `Date: ${formatDate(quote.invoicedAt ?? new Date(), regional)}`,
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
              billTo.attention ? `Attention: ${billTo.attention}` : "",
              billTo.phone,
              billTo.email,
              billTo.address,
              billTo.vatNumber ? `VAT no: ${billTo.vatNumber}` : "",
            ]}
          />
          <InfoBlock
            title="Invoice details"
            lines={[`Invoice ${formatInvoiceNumber(quote.invoiceNumber)}`, `Quote Q-${quote.number}`, `Status: ${quote.status}`]}
          />
        </div>
        <ItemsTable rows={[...includedLines(quote.items), ...feeRows(quote.fees)]} showPrices totals={totals} regional={regional} />
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
