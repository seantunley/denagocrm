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

export default async function AgreementPrintPage({
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
  // Once the sales agreement layout is PUBLISHED in the document editor, it
  // prints from there; until then, this page prints exactly as it always has.
  const builderHref = await builderDocRedirect(id, "agreement", search, () => publishedBuilderTemplateFor("agreement"));
  if (builderHref) redirect(builderHref);
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { items: true, fees: { orderBy: { sortOrder: "asc" } }, contact: true, lead: { include: { product: true } } },
  });
  if (!quote) notFound();
  // The company this document is FROM. getCompanyProfile now inherits the
  // platform-set tenant brand when the tenant has not filled in its own profile.
  const company = await getCompanyProfile();
  const regional = await getRegionalSettings();
  const tpl = await getDocTemplate("agreement", tplId);
  // Fees and delivery are part of what the customer pays; the subtotal is not.
  // The rows the customer can see must add up to the price they are agreeing
  // to — in either tax mode. See documentTotals().
  const totals = documentTotals(quote);
  // The PURCHASER on a sales agreement is the entity that owes the money — the
  // fleet account when there is one, not the person who happens to sign for it.
  const billTo = quoteBillTo(quote, await loadBillToFleet(prisma, quote.fleetId));
  const customer = billTo.name;

  return (
    <>
      <PrintActions backHref={`/quotes/${quote.id}`} backLabel="Back to quote" />
      <PrintDocShell
        company={company}
        template={tpl}
        title="Sales agreement"
        number={`SA-${quote.number}`}
        meta={[`Date: ${formatDate(new Date(), regional)}`, `Reference: Q-${quote.number}`]}
        parties={{ left: "Purchaser signature · Date", right: `For ${company.name} · Date` }}
        bodySection="clauses"
        bodyTitle="Terms of sale"
      >
        <div className="grid grid-cols-2 gap-4 mb-6">
          <InfoBlock
            title="Purchaser"
            accent
            lines={[
              customer,
              billTo.attention ? `Attention: ${billTo.attention}` : "",
              billTo.phone,
              billTo.email,
              billTo.address,
              billTo.registrationNumber ? `Reg. no: ${billTo.registrationNumber}` : "",
              billTo.vatNumber ? `VAT no: ${billTo.vatNumber}` : "",
            ]}
          />
          <InfoBlock
            title="Seller"
            lines={[company.name, company.tagline, company.address]}
          />
        </div>
        {tpl.sections.items !== false && (
          <ItemsTable
            rows={[...includedLines(quote.items), ...feeRows(quote.fees)]}
            showPrices
            regional={regional}
            totals={totals.map((line) => (line.strong ? { ...line, label: "Purchase price" } : line))}
          />
        )}
      </PrintDocShell>
    </>
  );
}
