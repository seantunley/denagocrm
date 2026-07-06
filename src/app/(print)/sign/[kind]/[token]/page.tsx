import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import SignPanel from "@/components/SignPanel";
import { contactName, formatDate, formatZAR } from "@/lib/format";

export const metadata = { title: "Denago Cape Town — Sign document", robots: { index: false } };

export default async function SignPage({
  params,
}: {
  params: Promise<{ kind: string; token: string }>;
}) {
  const { kind, token } = await params;
  if (!["quote", "jobcard"].includes(kind) || !/^[a-f0-9]{48,64}$/.test(token)) notFound();

  let doc: {
    refNumber: string;
    customerName: string;
    vehicleLine: string | null;
    description: string | null;
    items: { id: string; description: string; qty: number; unitPriceCents: number }[];
    termsLines: string[];
    validUntil: Date | null;
    signedAt: Date | null;
    signedByName: string | null;
  } | null = null;

  if (kind === "quote") {
    const quote = await prisma.quote.findFirst({
      where: { signToken: token },
      include: { items: true, contact: true, lead: { include: { product: true } } },
    });
    if (!quote) notFound();
    doc = {
      refNumber: `Q-${quote.number}`,
      customerName: quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "",
      vehicleLine: quote.lead?.product
        ? `${quote.lead.product.name}${quote.lead.color ? ` — ${quote.lead.color}` : ""}`
        : null,
      description: null,
      items: quote.items,
      termsLines: (quote.terms ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
      validUntil: quote.validUntil,
      signedAt: quote.signedAt,
      signedByName: quote.signedByName,
    };
  } else {
    const jobCard = await prisma.jobCard.findFirst({
      where: { signToken: token },
      include: { items: true, contact: true, vehicle: true },
    });
    if (!jobCard) notFound();
    doc = {
      refNumber: `#${jobCard.number}`,
      customerName: contactName(jobCard.contact),
      vehicleLine: `${jobCard.vehicle.model}${jobCard.vehicle.vin ? ` · VIN ${jobCard.vehicle.vin}` : ""}`,
      description: jobCard.description,
      items: jobCard.items,
      termsLines: [],
      validUntil: null,
      signedAt: jobCard.signedAt,
      signedByName: jobCard.signedByName,
    };
  }

  const total = doc.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 text-sm text-slate-800">
      {/* Brand banner */}
      <div className="flex items-center justify-between rounded-xl bg-[#020617] px-6 py-4 mb-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/branding/denago-logo-email.png"
          alt="Denago Cape Town EV"
          className="h-9 w-auto object-contain"
        />
        <div className="text-right">
          <p className="text-lg font-bold tracking-widest text-white">
            {kind === "quote" ? "QUOTATION" : "JOB CARD"}
          </p>
          <p className="text-base font-bold text-orange-500">{doc.refNumber}</p>
        </div>
      </div>

      <div className="rounded-lg bg-slate-50 border-l-4 border-orange-600 px-4 py-3 mb-5">
        <p className="font-bold text-slate-900">{doc.customerName}</p>
        {doc.vehicleLine && <p className="text-slate-600">{doc.vehicleLine}</p>}
        {doc.validUntil && (
          <p className="text-xs text-slate-500 mt-1">Valid until {formatDate(doc.validUntil)}</p>
        )}
      </div>

      {doc.description && (
        <div className="mb-5">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            Work requested
          </p>
          <p className="whitespace-pre-wrap">{doc.description}</p>
        </div>
      )}

      <table className="w-full border-collapse mb-4">
        <thead>
          <tr className="bg-[#020617] text-left">
            <th className="py-2 px-3 text-[10px] font-bold uppercase tracking-widest text-white">
              Description
            </th>
            <th className="py-2 px-3 text-[10px] font-bold uppercase tracking-widest text-white text-right">Qty</th>
            <th className="py-2 px-3 text-[10px] font-bold uppercase tracking-widest text-white text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.map((i, idx) => (
            <tr key={i.id} className={idx % 2 === 1 ? "bg-slate-50" : ""}>
              <td className="py-2 px-3 border-b border-slate-200">{i.description}</td>
              <td className="py-2 px-3 border-b border-slate-200 text-right">{i.qty}</td>
              <td className="py-2 px-3 border-b border-slate-200 text-right font-medium">
                {formatZAR(Math.round(i.qty * i.unitPriceCents))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex justify-end mb-6">
        <div className="rounded-lg bg-orange-600 text-white px-5 py-2.5 flex items-baseline gap-4">
          <span className="text-[10px] font-bold uppercase tracking-widest">Total incl. VAT</span>
          <span className="text-xl font-bold">{formatZAR(Math.round(total))}</span>
        </div>
      </div>

      {doc.termsLines.length > 0 && (
        <div className="rounded-lg bg-slate-50 px-4 py-3 mb-6">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
            Terms
          </p>
          <ul className="text-xs text-slate-600 space-y-1 list-disc pl-4">
            {doc.termsLines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {doc.signedAt ? (
        <div className="rounded-xl border-2 border-emerald-600 bg-emerald-50 p-6 text-center">
          <p className="text-3xl mb-2">✅</p>
          <p className="text-lg font-bold text-emerald-800">
            Signed by {doc.signedByName} on {formatDate(doc.signedAt)}
          </p>
          <p className="text-sm text-emerald-700 mt-1">Nothing more to do — thank you!</p>
        </div>
      ) : (
        <SignPanel token={token} kind={kind as "quote" | "jobcard"} />
      )}

      <p className="text-[11px] text-slate-400 mt-8 text-center">
        Denago Cape Town · Authorized Denago EV Dealer · 081 515 8319 · denagocpt.co.za
      </p>
    </div>
  );
}
