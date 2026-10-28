import PrintActions from "@/components/PrintActions";
import PrintDocShell, { InfoBlock } from "@/components/print/PrintDocShell";
import type { AccountStatement } from "@/lib/accountStatement";
import type { DocTemplate } from "@/lib/docTemplates";
import { formatDate, formatZAR, type Regional } from "@/lib/format";

/**
 * The printed customer statement — shared by the contact and fleet routes, which
 * differ only in who the account is. Branding, banking details and footer come
 * from the INVOICE template, so a statement looks like the invoices it lists.
 */
export default function StatementDocument({
  company,
  template,
  regional,
  statement,
  accountName,
  billToLines,
  statementDate,
  backHref,
  backLabel,
  note,
}: {
  company: { name: string; tagline: string; logoUrl: string; facebook?: string; instagram?: string };
  template: DocTemplate;
  regional: Regional;
  statement: AccountStatement;
  accountName: string;
  billToLines: (string | null | undefined)[];
  statementDate: Date;
  backHref: string;
  backLabel: string;
  /** Staff-only context printed above the page (e.g. invoices billed to a fleet). */
  note?: string | null;
}) {
  const money = (cents: number) => formatZAR(cents, regional);
  const owing = statement.balanceCents;
  // A statement is not signed: never print the invoice's "Received by" lines.
  const tpl: DocTemplate = { ...template, sections: { ...template.sections, signatures: false } };

  return (
    <>
      <PrintActions backHref={backHref} backLabel={backLabel} />
      {(statement.warnings.length > 0 || note) && (
        <div className="print:hidden mx-auto mt-4 max-w-3xl space-y-3 px-6">
          {statement.warnings.length > 0 && (
            <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-semibold">Check before sending — this box is not printed</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5">
                {statement.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          {note && <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">{note}</p>}
        </div>
      )}
      <PrintDocShell
        company={company}
        template={tpl}
        title="Statement"
        meta={[`Statement date: ${formatDate(statementDate, regional)}`, `Account: ${accountName}`]}
        bodySection="banking"
        bodyTitle="Payment details"
      >
        <div className="mb-6 grid grid-cols-2 gap-4">
          <InfoBlock title="Statement for" accent lines={billToLines} />
          <InfoBlock
            title="Account summary"
            lines={[
              owing > 0 ? `Balance due: ${money(owing)}` : owing < 0 ? `In credit: ${money(-owing)}` : "Paid up — nothing owing",
              `Invoiced: ${money(statement.totalInvoicedCents)}`,
              `Paid: ${money(statement.totalPaidCents)}`,
            ]}
          />
        </div>

        {statement.lines.length === 0 ? (
          <p className="rounded-lg bg-slate-50 px-4 py-6 text-center text-slate-500">No invoices on this account yet.</p>
        ) : (
          <>
            <table className="mb-2 w-full border-collapse text-xs">
              <thead>
                <tr className="bg-[#020617] text-left">
                  {["Date", "Reference", "Description"].map((heading) => (
                    <th key={heading} className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-widest text-white">
                      {heading}
                    </th>
                  ))}
                  {["Charges", "Payments", "Balance"].map((heading) => (
                    <th key={heading} className="px-3 py-2.5 text-right text-[10px] font-bold uppercase tracking-widest text-white">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {statement.lines.map((line, index) => (
                  <tr key={line.key} className={index % 2 === 1 ? "bg-slate-50" : ""}>
                    <td className="whitespace-nowrap border-b border-slate-200 px-3 py-2">{formatDate(line.date, regional)}</td>
                    <td className="whitespace-nowrap border-b border-slate-200 px-3 py-2 font-medium text-slate-900">{line.invoiceLabel}</td>
                    <td className="border-b border-slate-200 px-3 py-2 text-slate-700">{line.description}</td>
                    <td className="whitespace-nowrap border-b border-slate-200 px-3 py-2 text-right tabular-nums">
                      {line.debitCents ? money(line.debitCents) : ""}
                    </td>
                    <td className="whitespace-nowrap border-b border-slate-200 px-3 py-2 text-right tabular-nums">
                      {line.creditCents ? money(line.creditCents) : ""}
                    </td>
                    <td className="whitespace-nowrap border-b border-slate-200 px-3 py-2 text-right font-medium tabular-nums">
                      {money(line.balanceCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="no-break mt-4 flex justify-end">
              <div className="w-80">
                <div className="flex justify-between px-6 py-1 text-sm text-slate-600">
                  <span>Total invoiced</span>
                  <span className="tabular-nums">{money(statement.totalInvoicedCents)}</span>
                </div>
                <div className="flex justify-between px-6 py-1 text-sm text-slate-600">
                  <span>Less deposits &amp; payments</span>
                  <span className="tabular-nums">−{money(statement.totalPaidCents)}</span>
                </div>
                <div className="mt-1 flex items-baseline justify-between gap-6 rounded-lg bg-orange-600 px-6 py-3 text-white">
                  <span className="text-[11px] font-bold uppercase tracking-widest">{owing < 0 ? "In credit" : "Balance due"}</span>
                  <span className="text-2xl font-bold tabular-nums">{money(Math.abs(owing))}</span>
                </div>
              </div>
            </div>

            <div className="no-break mt-8">
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">Invoices</p>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b-2 border-slate-900 text-left">
                    <th className="px-3 py-2 font-semibold">Invoice</th>
                    <th className="px-3 py-2 font-semibold">Date</th>
                    <th className="px-3 py-2 text-right font-semibold">Total</th>
                    <th className="px-3 py-2 text-right font-semibold">Paid</th>
                    <th className="px-3 py-2 text-right font-semibold">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.invoices.map((invoice) => (
                    <tr key={invoice.quoteId} className="border-b border-slate-200">
                      <td className="px-3 py-2 font-medium text-slate-900">{invoice.invoiceLabel}</td>
                      <td className="px-3 py-2">{formatDate(invoice.date, regional)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(invoice.totalCents)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(invoice.paidCents)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(invoice.outstandingCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </PrintDocShell>
    </>
  );
}
