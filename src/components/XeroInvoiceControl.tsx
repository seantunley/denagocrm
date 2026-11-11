import { SaveForm, SaveButton } from "@/components/SaveForm";
import { refreshXeroInvoice, sendQuoteToXero } from "@/app/actions/xero";
import { XERO_UNCONFIRMED, totalsDiffer, xeroInvoiceCancelled, xeroInvoiceUrl, xeroSendUncertain, xeroStatusLabel } from "@/lib/xeroInvoice";

/**
 * An invoice's Xero copy on the Deliveries board. Only an ISSUED invoice (with its
 * INV number) can be sent — "quotes can change, invoices are final" (Sean,
 * 2026-11-11). After sending: Xero's OWN number and status beside ours, a link into
 * Xero and "Refresh" to pick up approval, payment or a void. Voided in Xero → it
 * can be sent again. Shown only to people who can invoice (deliveries.manage) and
 * only once Xero is connected — the actions re-check both.
 */
export default function XeroInvoiceControl({
  quote,
  crmTotalCents,
}: {
  quote: {
    id: string;
    invoiceNumber: number | null;
    xeroInvoiceId: string | null;
    xeroInvoiceNumber: string | null;
    xeroStatus: string | null;
    xeroTotalCents: number | null;
  };
  crmTotalCents: number;
}) {
  const link = "text-[11px] text-primary hover:underline";
  if (!quote.invoiceNumber) {
    return <p className="mt-1.5 text-[11px] text-muted-foreground">No CRM invoice number, so it can&apos;t be sent to Xero.</p>;
  }
  const voided = Boolean(quote.xeroInvoiceId) && xeroInvoiceCancelled(quote.xeroStatus);
  const sendButton = (
    <SaveForm action={sendQuoteToXero.bind(null, quote.id)} resetOnSuccess={false} className="inline">
      <SaveButton className="btn-secondary btn-sm" pendingLabel="Sending to Xero…">
        {quote.xeroStatus === "SENDING"
          ? "Sending to Xero… (try again)"
          : quote.xeroStatus === XERO_UNCONFIRMED
            ? "Send didn't finish — check Xero and link"
            : voided
              ? "Send invoice to Xero again"
              : "Send invoice to Xero"}
      </SaveButton>
    </SaveForm>
  );
  // Not sent, or a send in progress / unfinished (a voided invoice being replaced stays linked until then).
  if (!quote.xeroInvoiceId || xeroSendUncertain(quote.xeroStatus)) return <div className="mt-1.5">{sendButton}</div>;
  const differs = !voided && totalsDiffer(quote.xeroTotalCents, crmTotalCents);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
        Xero {quote.xeroInvoiceNumber ?? "invoice"} · {xeroStatusLabel(quote.xeroStatus)}
      </span>
      <a href={xeroInvoiceUrl(quote.xeroInvoiceId)} target="_blank" rel="noreferrer" className={link}>Open in Xero</a>
      {voided ? (
        sendButton
      ) : (
        <SaveForm action={refreshXeroInvoice.bind(null, quote.id)} resetOnSuccess={false} className="inline">
          <SaveButton className={link} pendingLabel="Refreshing…">Refresh</SaveButton>
        </SaveForm>
      )}
      {differs && (
        <span className="text-[10px] text-amber-300">Xero&apos;s total differs from the invoice — check the VAT in Xero.</span>
      )}
    </div>
  );
}
