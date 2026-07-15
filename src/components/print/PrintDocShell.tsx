import type { DocTemplate } from "@/lib/docTemplates";
import { formatZAR } from "@/lib/format";
import { lineNetCents } from "@/lib/pricing";

/** Shared line-items table used by invoice / agreement / delivery / service report. */
export function ItemsTable({
  rows,
  showPrices,
  totalCents,
  totalLabel = "Total incl. VAT",
}: {
  rows: { description: string; qty: number; unitPriceCents?: number; discountPct?: number | null }[];
  showPrices: boolean;
  totalCents?: number;
  totalLabel?: string;
}) {
  return (
    <>
      <table className="w-full border-collapse mb-2">
        <thead>
          <tr className="bg-[#020617] text-left">
            <th className="py-2.5 px-3 text-[10px] font-bold uppercase tracking-widest text-white">
              Description
            </th>
            <th className="py-2.5 px-3 text-[10px] font-bold uppercase tracking-widest text-white text-right">
              Qty
            </th>
            {showPrices && (
              <>
                <th className="py-2.5 px-3 text-[10px] font-bold uppercase tracking-widest text-white text-right">
                  Unit price
                </th>
                <th className="py-2.5 px-3 text-[10px] font-bold uppercase tracking-widest text-white text-right">
                  Total
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx} className={idx % 2 === 1 ? "bg-slate-50" : ""}>
              <td className="py-2.5 px-3 border-b border-slate-200 font-medium text-slate-900">
                {r.description}
              </td>
              <td className="py-2.5 px-3 border-b border-slate-200 text-right">{r.qty}</td>
              {showPrices && (
                <>
                  <td className="py-2.5 px-3 border-b border-slate-200 text-right">
                    {formatZAR(r.unitPriceCents ?? 0)}
                  </td>
                  <td className="py-2.5 px-3 border-b border-slate-200 text-right font-medium">
                    {formatZAR(lineNetCents({ qty: r.qty, unitPriceCents: r.unitPriceCents ?? 0, discountPct: r.discountPct }))}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {showPrices && totalCents !== undefined && (
        <div className="flex justify-end mt-4 no-break">
          <div className="rounded-lg bg-orange-600 text-white px-6 py-3 flex items-baseline gap-6">
            <span className="text-[11px] font-bold uppercase tracking-widest">{totalLabel}</span>
            <span className="text-2xl font-bold">{formatZAR(Math.round(totalCents))}</span>
          </div>
        </div>
      )}
    </>
  );
}

/** Small labelled info block (customer / vehicle / driver details). */
export function InfoBlock({
  title,
  accent = false,
  lines,
}: {
  title: string;
  accent?: boolean;
  lines: (string | null | undefined)[];
}) {
  return (
    <div
      className={`rounded-lg bg-slate-50 border-l-4 px-4 py-3 ${
        accent ? "border-orange-600" : "border-slate-900"
      }`}
    >
      <p
        className={`text-[10px] font-bold uppercase tracking-widest mb-1.5 ${
          accent ? "text-orange-600" : "text-slate-500"
        }`}
      >
        {title}
      </p>
      {lines.filter(Boolean).map((l, i) => (
        <p key={i} className={i === 0 ? "font-bold text-slate-900" : "text-slate-600"}>
          {l}
        </p>
      ))}
    </div>
  );
}

/**
 * Shared branded chrome for generated documents (invoice, agreement,
 * indemnity, delivery note, service report, warranty claim). One shell,
 * template-driven — each document page only maps its own data table(s).
 */
export default function PrintDocShell({
  template: tpl,
  title,
  number,
  meta = [],
  parties = { left: "Customer signature · Date", right: "For Denago Cape Town · Date" },
  bodySection, // section id that gates tpl.bodyText (e.g. "clauses", "waiver", "banking")
  bodyTitle,
  children,
}: {
  template: DocTemplate;
  title: string;
  number?: string;
  meta?: string[];
  parties?: { left: string; right: string | null };
  bodySection?: string;
  bodyTitle?: string;
  children?: React.ReactNode;
}) {
  const showBody = bodySection ? tpl.sections[bodySection] !== false && tpl.bodyText : false;
  const sigOn = tpl.sections.signatures !== false;
  const pos = tpl.signature.position;
  const rightLabel = tpl.signature.dealerCounterSign ? parties.right : null;

  const line = (label: string) => (
    <div className="border-t-2 border-slate-900 pt-2 mt-14">
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  );

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

      <div className="print-page max-w-3xl mx-auto px-6 py-8 print:p-0 text-sm text-slate-800 bg-white">
        {/* Brand banner */}
        <div className="flex items-center justify-between rounded-xl bg-[#020617] px-7 py-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={tpl.logoUrl ?? "/branding/denago-logo-email.png"}
            alt="Denago Cape Town EV"
            className="h-11 w-auto object-contain"
          />
          <div className="text-right">
            <p className="text-2xl font-bold tracking-widest text-white uppercase">{title}</p>
            {number && <p className="text-lg font-bold text-orange-500">{number}</p>}
          </div>
        </div>

        {/* Meta strip */}
        {(meta.length > 0 || tpl.intro) && (
          <div className="px-1 py-3">
            {meta.length > 0 && (
              <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 text-xs text-slate-500">
                {meta.map((m, i) => (
                  <span key={i}>{m}</span>
                ))}
              </div>
            )}
            {tpl.intro && <p className="mt-1 text-xs italic text-slate-500">{tpl.intro}</p>}
          </div>
        )}

        {/* Document-specific content */}
        <div className="mt-2">{children}</div>

        <div className="print-bottom">
          {/* Template body text (clauses / waiver / banking details…) */}
          {showBody && (
            <div className="rounded-lg bg-slate-50 px-4 py-3 mt-8 no-break">
              {bodyTitle && (
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
                  {bodyTitle}
                </p>
              )}
              <div className="text-xs text-slate-600 space-y-1 whitespace-pre-wrap leading-5">
                {tpl.bodyText}
              </div>
            </div>
          )}

          {/* Signatures */}
          {sigOn && (
            <div
              className={
                pos === "strip" || !rightLabel
                  ? "grid grid-cols-1 gap-6 mt-10 mb-10 no-break"
                  : "grid grid-cols-2 gap-12 mt-10 mb-10 no-break"
              }
            >
              {pos === "right-left" && rightLabel ? (
                <>
                  {line(rightLabel)}
                  {line(parties.left)}
                </>
              ) : (
                <>
                  {line(parties.left)}
                  {rightLabel && line(rightLabel)}
                </>
              )}
            </div>
          )}

          {/* Branded footer */}
          {tpl.sections.footer !== false && (
            <div className="border-t-2 border-orange-600 pt-4 flex items-start justify-between gap-6 flex-wrap no-break">
              <div className="text-[10px] text-slate-500 leading-4">
                <p className="font-bold text-slate-700 text-[11px]">
                  Denago Cape Town — Authorized Denago EV Dealer
                </p>
                {tpl.footerLines.map((l, i) => (
                  <p key={i}>{l}</p>
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
