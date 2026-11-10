import { SaveForm, SaveButton } from "@/components/SaveForm";
import { refreshXeroInvoice, sendQuoteToXero } from "@/app/actions/xero";
import { totalsDiffer, xeroInvoiceUrl, xeroStatusLabel } from "@/lib/xeroInvoice";

/**
 * A quote's Xero invoice on the Deliveries board. Before it is sent: "Send to
 * Xero". After: Xero's OWN invoice number and status beside ours, a link into
 * Xero and "Refresh" to pick up approval or payment. Shown only to people who
 * can invoice (deliveries.manage) and only once Xero is connected — the actions
 * re-check both.
 */
export default function XeroInvoiceControl({
  quote,
  crmTotalCents,
}: {
  quote: {
    id: string;
    xeroInvoiceId: string | null;
    xeroInvoiceNumber: string | null;
    xeroStatus: string | null;
    xeroTotalCents: number | null;
  };
  crmTotalCents: number;
}) {
  const link = "text-[11px] text-primary hover:underline";
  if (!quote.xeroInvoiceId) {
    return (
      <SaveForm action={sendQuoteToXero.bind(null, quote.id)} resetOnSuccess={false} className="mt-1.5">
        <SaveButton className="btn-secondary btn-sm" pendingLabel="Sending to Xero…">
          {quote.xeroStatus === "SENDING" ? "Sending to Xero… (try again)" : "Send to Xero"}
        </SaveButton>
      </SaveForm>
    );
  }
  const differs = totalsDiffer(quote.xeroTotalCents, crmTotalCents);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
        Xero {quote.xeroInvoiceNumber ?? "invoice"} · {xeroStatusLabel(quote.xeroStatus)}
      </span>
      <a href={xeroInvoiceUrl(quote.xeroInvoiceId)} target="_blank" rel="noreferrer" className={link}>Open in Xero</a>
      <SaveForm action={refreshXeroInvoice.bind(null, quote.id)} resetOnSuccess={false} className="inline">
        <SaveButton className={link} pendingLabel="Refreshing…">Refresh</SaveButton>
      </SaveForm>
      {differs && (
        <span className="text-[10px] text-amber-300">Xero&apos;s total differs from the quote — check the VAT in Xero.</span>
      )}
    </div>
  );
}
