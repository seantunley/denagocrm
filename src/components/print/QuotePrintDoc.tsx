import type { Prisma } from "@prisma/client";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { defaultTemplate, type DocTemplate } from "@/lib/docTemplates";

export type QuoteForPrint = Prisma.QuoteGetPayload<{
  include: { items: true; lead: { include: { product: true } }; contact: true; createdBy: true };
}>;

/** The branded quotation document — used by the internal print page, the
 *  public signing print page, and the signed-PDF renderer. Layout knobs
 *  (logo, terms, signatures, footer) come from the Documents template. */
export default function QuotePrintDoc({
  quote,
  template,
}: {
  quote: QuoteForPrint;
  template?: DocTemplate;
}) {
  const tpl = template ?? defaultTemplate("quote");
  const total = quote.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const termsText = tpl.terms ?? quote.terms;
  const customerName = quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "";
  const phone = quote.contact?.phone ?? quote.lead?.phone;
  const email = quote.contact?.email ?? quote.lead?.email;
  const address = quote.contact
    ? [quote.contact.address, quote.contact.suburb, quote.contact.city, quote.contact.province, quote.contact.postalCode]
        .filter(Boolean)
        .join(", ")
    : "";

  return (
    <>
      <style>{`
        @page { margin: 12mm; }
        @media print {
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .no-break { break-inside: avoid; }
          .print-page { display: flex; flex-direction: column; min-height: 262mm; }
          .print-bottom { margin-top: auto; }
        }
      `}</style>

      <div className="print-page max-w-3xl mx-auto px-6 py-8 print:p-0 text-sm text-slate-800">
        {/* Brand banner */}
        <div className="flex items-center justify-between rounded-xl bg-[#020617] px-7 py-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={tpl.logoUrl ?? "/branding/denago-logo-email.png"}
            alt="Denago Cape Town EV"
            className="h-11 w-auto object-contain"
          />
          <div className="text-right">
            <p className="text-2xl font-bold tracking-widest text-white">QUOTATION</p>
            <p className="text-lg font-bold text-orange-500">Q-{quote.number}</p>
          </div>
        </div>

        {/* Meta strip */}
        <div className="flex justify-between items-center px-1 py-3 text-xs text-slate-500">
          <span>Date: {formatDate(quote.createdAt)}</span>
          {quote.validUntil && <span>Valid until: {formatDate(quote.validUntil)}</span>}
          {quote.createdBy && <span>Prepared by: {quote.createdBy.name}</span>}
        </div>

        {/* Customer / vehicle blocks */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="rounded-lg bg-slate-50 border-l-4 border-orange-600 px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-orange-600 mb-1.5">
              Prepared for
            </p>
            <p className="font-bold text-slate-900">{customerName}</p>
            {phone && <p className="text-slate-600">{phone}</p>}
            {email && <p className="text-slate-600">{email}</p>}
            {address && <p className="text-slate-600 text-xs mt-1">{address}</p>}
          </div>
          <div className="rounded-lg bg-slate-50 border-l-4 border-slate-900 px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
              Vehicle of interest
            </p>
            <p className="font-bold text-slate-900">
              {quote.lead?.product?.name ?? quote.items[0]?.description ?? "—"}
            </p>
            {quote.lead?.color && <p className="text-slate-600">Colour: {quote.lead.color}</p>}
            <p className="text-slate-600 text-xs mt-1">
              Demo drives available at your estate or our Maitland showroom.
            </p>
          </div>
        </div>

        {/* Items */}
        <table className="w-full border-collapse mb-2">
          <thead>
            <tr className="bg-[#020617] text-left">
              <th className="py-2.5 px-3 text-[10px] font-bold uppercase tracking-widest text-white">
                Description
              </th>
              <th className="py-2.5 px-3 text-[10px] font-bold uppercase tracking-widest text-white text-right">Qty</th>
              <th className="py-2.5 px-3 text-[10px] font-bold uppercase tracking-widest text-white text-right">Unit price</th>
              <th className="py-2.5 px-3 text-[10px] font-bold uppercase tracking-widest text-white text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {quote.items.map((i, idx) => (
              <tr key={i.id} className={idx % 2 === 1 ? "bg-slate-50" : ""}>
                <td className="py-2.5 px-3 border-b border-slate-200 font-medium text-slate-900">
                  {i.description}
                </td>
                <td className="py-2.5 px-3 border-b border-slate-200 text-right">{i.qty}</td>
                <td className="py-2.5 px-3 border-b border-slate-200 text-right">
                  {formatZAR(i.unitPriceCents)}
                </td>
                <td className="py-2.5 px-3 border-b border-slate-200 text-right font-medium">
                  {formatZAR(Math.round(i.qty * i.unitPriceCents))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Total band */}
        <div className="flex justify-end mt-4 mb-10 no-break">
          <div className="rounded-lg bg-orange-600 text-white px-6 py-3 flex items-baseline gap-6">
            <span className="text-[11px] font-bold uppercase tracking-widest">
              Total incl. VAT
            </span>
            <span className="text-2xl font-bold">{formatZAR(Math.round(total))}</span>
          </div>
        </div>

        <div className="print-bottom">
          {tpl.sections.terms !== false && termsText && (
            <div className="rounded-lg bg-slate-50 px-4 py-3 mb-12 no-break">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
                Terms
              </p>
              <ul className="text-xs text-slate-600 space-y-1 list-disc pl-4">
                {termsText
                  .split(/\r?\n/)
                  .map((line) => line.replace(/^[\s•\-*]+/, "").trim())
                  .filter(Boolean)
                  .map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
              </ul>
            </div>
          )}

          {/* Signatures — position + dealer box come from the template.
              A signed quote ALWAYS shows the signature evidence. */}
          {(tpl.sections.signatures !== false || quote.signedAt) &&
            (() => {
              const customerBlock = (
                <div>
                  {quote.signedAt ? (
                    <>
                      {quote.signatureRef?.startsWith("http") && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={quote.signatureRef} alt="Customer signature" className="h-14 w-auto mb-1" />
                      )}
                      <div className="border-t-2 border-slate-900 pt-2">
                        <p className="text-xs text-slate-600">
                          Accepted — signed electronically by <b>{quote.signedByName}</b> on{" "}
                          {formatDate(quote.signedAt)}
                          {quote.signerIp ? ` · IP ${quote.signerIp}` : ""} · ECT Act, 2002
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="border-t-2 border-slate-900 pt-2 mt-14">
                      <p className="text-xs text-slate-500">Accepted — customer signature &amp; date</p>
                    </div>
                  )}
                </div>
              );
              const dealerBlock =
                tpl.signature.dealerCounterSign || quote.dealerSignedAt ? (
                  <div>
                    {quote.dealerSignedAt ? (
                      <>
                        {quote.dealerSignatureRef?.startsWith("http") && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={quote.dealerSignatureRef} alt="Denago signature" className="h-14 w-auto mb-1" />
                        )}
                        <div className="border-t-2 border-slate-900 pt-2">
                          <p className="text-xs text-slate-600">
                            For Denago Cape Town — <b>{quote.dealerSignedByName}</b>,{" "}
                            {formatDate(quote.dealerSignedAt)}
                          </p>
                        </div>
                      </>
                    ) : (
                      <div className="border-t-2 border-slate-900 pt-2 mt-14">
                        <p className="text-xs text-slate-500">Denago Cape Town &amp; date</p>
                      </div>
                    )}
                  </div>
                ) : null;
              const pos = tpl.signature.position;
              const cls =
                pos === "strip" || !dealerBlock
                  ? "grid grid-cols-1 gap-8 mt-14 mb-12 no-break"
                  : "grid grid-cols-2 gap-12 mt-14 mb-12 no-break";
              return (
                <div className={cls}>
                  {pos === "right-left" && dealerBlock ? (
                    <>
                      {dealerBlock}
                      {customerBlock}
                    </>
                  ) : (
                    <>
                      {customerBlock}
                      {dealerBlock}
                    </>
                  )}
                </div>
              );
            })()}

          {/* Branded footer */}
          {tpl.sections.footer !== false && (
            <div className="border-t-2 border-orange-600 pt-4 flex items-start justify-between gap-6 flex-wrap no-break">
              <div className="text-[10px] text-slate-500 leading-4">
                <p className="font-bold text-slate-700 text-[11px]">
                  Denago Cape Town — Authorized Denago EV Dealer
                </p>
                {tpl.footerLines.map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/branding/social-facebook.png" alt="Facebook" className="h-5 w-5" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/branding/social-instagram.png" alt="Instagram" className="h-5 w-5" />
                <span className="text-[10px] text-slate-500">@denago_capetown</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
