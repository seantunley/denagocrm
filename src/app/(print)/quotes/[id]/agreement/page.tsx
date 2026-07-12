import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireQuoteReadAccess } from "@/lib/permissions";
import PrintActions from "@/components/PrintActions";
import PrintDocShell, { ItemsTable, InfoBlock } from "@/components/print/PrintDocShell";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { contactName, formatDate } from "@/lib/format";

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
    include: { items: true, contact: true, lead: { include: { product: true } } },
  });
  if (!quote) notFound();
  const tpl = await getDocTemplate("agreement", tplId);
  const total = quote.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const customer = quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "";
  const address = quote.contact
    ? [quote.contact.address, quote.contact.suburb, quote.contact.city].filter(Boolean).join(", ")
    : "";

  return (
    <>
      <PrintActions backHref={`/quotes/${quote.id}`} />
      <PrintDocShell
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
          <ItemsTable rows={quote.items} showPrices totalCents={total} totalLabel="Purchase price" />
        )}
      </PrintDocShell>
    </>
  );
}
