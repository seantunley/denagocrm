import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireQuoteReadAccess } from "@/lib/permissions";
import PrintActions from "@/components/PrintActions";
import PrintDocShell, { ItemsTable, InfoBlock } from "@/components/print/PrintDocShell";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { contactName, formatDate } from "@/lib/format";
import { documentTotals, feeRows, includedLines } from "@/lib/pricing";

export default async function AgreementPrintPage({
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
    include: { items: true, fees: { orderBy: { sortOrder: "asc" } }, contact: true, lead: { include: { product: true } } },
  });
  if (!quote) notFound();
  // The company this document is FROM. getCompanyProfile now inherits the
  // platform-set tenant brand when the tenant has not filled in its own profile.
  const company = await getCompanyProfile();
  const tpl = await getDocTemplate("agreement", tplId);
  // Fees and delivery are part of what the customer pays; the subtotal is not.
  // The rows the customer can see must add up to the price they are agreeing
  // to — in either tax mode. See documentTotals().
  const totals = documentTotals(quote);
  const customer = quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "";
  const address = quote.contact
    ? [quote.contact.address, quote.contact.suburb, quote.contact.city].filter(Boolean).join(", ")
    : "";

  return (
    <>
      <PrintActions backHref={`/quotes/${quote.id}`} backLabel="Back to quote" />
      <PrintDocShell
        company={company}
        template={tpl}
        title="Sales agreement"
        number={`SA-${quote.number}`}
        meta={[`Date: ${formatDate(new Date())}`, `Reference: Q-${quote.number}`]}
        parties={{ left: "Purchaser signature · Date", right: "For Denago Cape Town · Date" }}
        bodySection="clauses"
        bodyTitle="Terms of sale"
      >
        <div className="grid grid-cols-2 gap-4 mb-6">
          <InfoBlock
            title="Purchaser"
            accent
            lines={[
              customer,
              quote.contact?.phone ?? quote.lead?.phone,
              quote.contact?.email ?? quote.lead?.email,
              address,
            ]}
          />
          <InfoBlock
            title="Seller"
            lines={[
              "Denago Cape Town",
              "Authorized Denago EV Dealer",
              "Unit 55, M5 Freeway Business Park, Maitland",
            ]}
          />
        </div>
        {tpl.sections.items !== false && (
          <ItemsTable
            rows={[...includedLines(quote.items), ...feeRows(quote.fees)]}
            showPrices
            totals={totals.map((line) => (line.strong ? { ...line, label: "Purchase price" } : line))}
          />
        )}
      </PrintDocShell>
    </>
  );
}
