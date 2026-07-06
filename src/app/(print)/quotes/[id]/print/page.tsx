import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import PrintActions from "@/components/PrintActions";
import { contactName, formatDate, formatZAR } from "@/lib/format";

export default async function QuotePrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { items: true, lead: { include: { product: true } }, contact: true, createdBy: true },
  });
  if (!quote) notFound();
  const total = quote.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);

  const customerName = quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "";
  const address = quote.contact
    ? [quote.contact.address, quote.contact.suburb, quote.contact.city, quote.contact.province, quote.contact.postalCode]
        .filter(Boolean)
        .join(", ")
    : "";

  return (
    <>
      <PrintActions backHref={`/quotes/${quote.id}`} />

      <div className="max-w-3xl mx-auto p-8 print:p-0 text-sm">
        <div className="flex items-start justify-between border-b-2 border-slate-900 pb-4">
          <div className="flex items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/branding/denago-mark.png" alt="Denago" className="h-14 w-auto object-contain" />
            <div>
              <p className="text-xl font-bold tracking-tight">
                DENAGO <span className="text-orange-600">CAPE TOWN</span>
              </p>
              <p className="text-xs text-slate-600">
                Unit 55, M5 Freeway Business Park, Maitland, Cape Town, 7405
              </p>
              <p className="text-xs text-slate-600">
                081 515 8319 · sales@denagocpt.co.za · denagocpt.co.za
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold">QUOTATION</p>
            <p className="text-lg font-semibold text-orange-600">Q-{quote.number}</p>
            <p className="text-xs text-slate-600">{formatDate(quote.createdAt)}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6 py-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
              Prepared for
            </p>
            <p className="font-semibold">{customerName}</p>
            {(quote.contact?.phone ?? quote.lead?.phone) && (
              <p>{quote.contact?.phone ?? quote.lead?.phone}</p>
            )}
            {(quote.contact?.email ?? quote.lead?.email) && (
              <p>{quote.contact?.email ?? quote.lead?.email}</p>
            )}
            {address && <p className="text-slate-600">{address}</p>}
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
              Quote details
            </p>
            {quote.validUntil && <p>Valid until: {formatDate(quote.validUntil)}</p>}
            {quote.createdBy && <p>Prepared by: {quote.createdBy.name}</p>}
            {quote.lead?.product && <p className="text-slate-600">{quote.lead.product.name}</p>}
          </div>
        </div>

        <table className="w-full border-collapse mb-5">
          <thead>
            <tr className="border-b-2 border-slate-900 text-left">
              <th className="py-1.5 pr-2 text-xs uppercase tracking-wide">Description</th>
              <th className="py-1.5 pr-2 text-xs uppercase tracking-wide text-right">Qty</th>
              <th className="py-1.5 pr-2 text-xs uppercase tracking-wide text-right">Unit price</th>
              <th className="py-1.5 text-xs uppercase tracking-wide text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {quote.items.map((i) => (
              <tr key={i.id} className="border-b border-slate-200">
                <td className="py-2 pr-2">{i.description}</td>
                <td className="py-2 pr-2 text-right">{i.qty}</td>
                <td className="py-2 pr-2 text-right">{formatZAR(i.unitPriceCents)}</td>
                <td className="py-2 text-right">{formatZAR(Math.round(i.qty * i.unitPriceCents))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex justify-end mb-8">
          <div className="w-64">
            <div className="flex justify-between border-t-2 border-slate-900 pt-2">
              <span className="font-bold">Total (incl. VAT)</span>
              <span className="font-bold text-lg">{formatZAR(Math.round(total))}</span>
            </div>
          </div>
        </div>

        {quote.terms && (
          <div className="mb-10">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
              Terms
            </p>
            <p className="text-slate-600 whitespace-pre-wrap text-xs">{quote.terms}</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-10 pt-6">
          <div>
            <div className="border-t border-slate-900 pt-1.5">
              <p className="text-xs text-slate-600">Accepted — signature · Date</p>
            </div>
          </div>
          <div>
            <div className="border-t border-slate-900 pt-1.5">
              <p className="text-xs text-slate-600">Denago Cape Town · Date</p>
            </div>
          </div>
        </div>

        <p className="text-[10px] text-slate-400 mt-10 text-center">
          Denago Cape Town · Authorized Denago EV Dealer · Quotation Q-{quote.number} · Generated{" "}
          {formatDate(new Date())}
        </p>
      </div>
    </>
  );
}
