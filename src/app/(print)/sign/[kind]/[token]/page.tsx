import { notFound } from "next/navigation";
import { prisma, basePrisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";
import SignPanel from "@/components/SignPanel";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { quoteExpired } from "@/lib/quoteExpiry";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ kind: string; token: string }>;
}) {
  const { kind } = await params;
  const isQuote = kind === "quote";
  const title = isQuote
    ? "Your quotation — Denago Cape Town"
    : "Your job card — Denago Cape Town";
  const description = isQuote
    ? "Review and accept your Denago Cape Town quotation online — it takes less than a minute."
    : "Review and sign your Denago Cape Town job card online.";
  return {
    title,
    description,
    robots: { index: false },
    openGraph: {
      title,
      description,
      siteName: "Denago Cape Town",
      type: "website",
      images: [{ url: "https://crm.denagocpt.co.za/branding/denago-logo-email.png" }],
    },
    twitter: { card: "summary", title, description },
  };
}

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
    dealerSignedByName?: string | null;
    dealerSignedAt?: Date | null;
    dealerSignatureRef?: string | null;
    declinedAt?: Date | null;
    expired?: boolean;
  } | null = null;

  if (kind === "quote") {
    const quote = await prisma.quote.findFirst({
      where: { signToken: token },
      include: { items: true, contact: true, lead: { include: { product: true } } },
    });
    if (!quote) notFound();
    // First-open tracking: tell the team the customer is looking at it
    if (!quote.viewedAt && !quote.signedAt) {
      try {
        await basePrisma.quote.update({
          where: { id: quote.id },
          data: { viewedAt: new Date() },
        });
        await logAudit({
          action: "quote.viewed",
          summary: `Quote Q-${quote.number} signing link opened for the first time`,
          contactId: quote.contactId,
          leadId: quote.leadId,
          userName: "Customer",
        });
        await sendPushToAll({
          title: "👀 Quote opened",
          body: `Q-${quote.number} — the signing link was just viewed`,
          url: `/quotes/${quote.id}`,
        }, "quote_viewed");
      } catch {}
    }
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
      dealerSignedByName: quote.dealerSignedByName,
      dealerSignedAt: quote.dealerSignedAt,
      dealerSignatureRef: quote.dealerSignatureRef,
      declinedAt: quote.declinedAt,
      expired: quoteExpired(quote.validUntil) && !quote.signedAt,
    };
  } else {
    const jobCard = await prisma.jobCard.findFirst({
      where: { signToken: token },
      include: { items: true, contact: true, vehicle: true },
    });
    if (!jobCard) notFound();
    if (!jobCard.viewedAt && !jobCard.signedAt) {
      try {
        await basePrisma.jobCard.update({
          where: { id: jobCard.id },
          data: { viewedAt: new Date() },
        });
        await logAudit({
          action: "jobcard.viewed",
          summary: `Job card #${jobCard.number} signing link opened for the first time`,
          contactId: jobCard.contactId,
          userName: "Customer",
        });
      } catch {}
    }
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
  const signable = !doc.signedAt && !doc.expired;

  return (
    <div className="min-h-screen bg-[#020617] bg-[radial-gradient(ellipse_at_top,rgba(234,88,12,0.08),transparent_60%)] pb-28 md:pb-16">
      {/* Slim branded bar that stays put while the document scrolls */}
      <header className="sticky top-0 z-20 bg-[#020617]/90 backdrop-blur border-b border-white/10">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/branding/denago-logo-email.png"
            alt="Denago Cape Town EV"
            className="h-7 w-auto object-contain"
          />
          <div className="text-right leading-tight">
            <p className="text-sm font-bold tracking-widest text-white">
              {kind === "quote" ? "QUOTATION" : "JOB CARD"}{" "}
              <span className="text-orange-500">{doc.refNumber}</span>
            </p>
            <p className="text-[11px] text-slate-400">
              {formatZAR(Math.round(total))} incl. VAT
              {doc.validUntil && !doc.signedAt ? ` · valid until ${formatDate(doc.validUntil)}` : ""}
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-3 sm:px-6 mt-6 md:mt-10">
        {/* The document itself: a white sheet on the desk */}
        <div className="bg-white rounded-xl ring-1 ring-white/10 shadow-[0_30px_70px_-20px_rgba(0,0,0,0.8)] px-5 py-8 sm:px-10 sm:py-12 text-sm text-slate-800">
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
          <span className="text-xl font-semibold tracking-[-0.025em]">{formatZAR(Math.round(total))}</span>
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

      {/* Denago's countersignature — the customer sees who signed for us before they sign */}
      {doc.dealerSignedByName && (
        <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1">
              Signed for Denago Cape Town
            </p>
            <p className="text-sm text-slate-700">
              <b>{doc.dealerSignedByName}</b>
              {doc.dealerSignedAt ? ` · ${formatDate(doc.dealerSignedAt)}` : ""}
            </p>
          </div>
          {doc.dealerSignatureRef?.startsWith("http") && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={doc.dealerSignatureRef}
              alt={`Signature — ${doc.dealerSignedByName}`}
              className="h-12 w-auto object-contain"
            />
          )}
        </div>
      )}

      <div id="sign" className="scroll-mt-20">
      {doc.signedAt ? (
        <div className="rounded-xl border-2 border-emerald-600 bg-emerald-50 p-6 text-center">
          <p className="text-3xl mb-2">✅</p>
          <p className="text-lg font-bold text-emerald-800">
            Signed by {doc.signedByName} on {formatDate(doc.signedAt)}
          </p>
          <p className="text-sm text-emerald-700 mt-1">Nothing more to do — thank you!</p>
        </div>
      ) : doc.expired ? (
        <div className="rounded-xl border-2 border-amber-500 bg-amber-50 p-6 text-center">
          <p className="text-3xl mb-2">⏳</p>
          <p className="text-lg font-bold text-amber-800">This quote has expired</p>
          <p className="text-sm text-amber-700 mt-1">
            It was valid until {doc.validUntil ? formatDate(doc.validUntil) : "recently"}. Give us
            a call on 073 789 3438 or reply to our email and we&apos;ll send you an updated one.
          </p>
        </div>
      ) : doc.declinedAt ? (
        <div className="rounded-xl border-2 border-slate-400 bg-slate-100 p-6 text-center">
          <p className="text-3xl mb-2">🙏</p>
          <p className="text-lg font-bold text-slate-700">
            You declined this quote on {formatDate(doc.declinedAt)}
          </p>
          <p className="text-sm text-slate-600 mt-1">
            Changed your mind? You can still sign below — or call us on 073 789 3438.
          </p>
          <div className="mt-5 text-left">
            <SignPanel token={token} kind={kind as "quote" | "jobcard"} />
          </div>
        </div>
      ) : (
        <SignPanel token={token} kind={kind as "quote" | "jobcard"} allowDecline={kind === "quote"} />
      )}
      </div>
        </div>

        <p className="text-[11px] text-slate-500 mt-6 text-center">
          Denago Cape Town · Authorized Denago EV Dealer · 073 789 3438 · denagocpt.co.za
        </p>
      </main>

      {/* On the phone, the pen is always within thumb's reach */}
      {signable && (
        <a
          href="#sign"
          className="md:hidden fixed bottom-4 left-4 right-4 z-30 rounded-xl bg-orange-600 py-3.5 text-center font-bold text-white shadow-[0_10px_30px_rgba(234,88,12,0.4)]"
        >
          ✍ {kind === "quote" ? "Review & accept this quote" : "Review & sign"}
        </a>
      )}
    </div>
  );
}
