import "server-only";

import { emitJourneyEvent } from "./journeyEvents";

/**
 * Stable contract for the future Xero connector. Call this after a webhook or sync
 * has persisted a changed invoice status. DenagoCRM receives only operational
 * references/statuses here — balances, tax and ledger values remain in Xero.
 */
export async function emitXeroInvoiceStatusChanged(args: {
  xeroInvoiceId: string;
  previousStatus: string | null;
  status: string;
  xeroInvoiceNumber?: string | null;
  quoteId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  tenantId?: string | null;
}) {
  const entityType = args.leadId ? "lead" : args.contactId ? "contact" : "system";
  const entityId = args.leadId ?? args.contactId ?? args.xeroInvoiceId;
  return emitJourneyEvent({
    type: "xero_invoice_status_changed",
    entityType,
    entityId,
    tenantId: args.tenantId,
    dedupeKey: `xero-invoice-status:${args.xeroInvoiceId}:${args.status}`,
    payload: {
      status: args.status,
      previousStatus: args.previousStatus,
      source: {
        id: args.xeroInvoiceId,
        entityType: "XeroInvoice",
        reference: args.xeroInvoiceNumber ?? args.xeroInvoiceId,
        status: args.status,
        previousStatus: args.previousStatus,
        quoteId: args.quoteId ?? null,
        contactId: args.contactId ?? null,
        leadId: args.leadId ?? null,
      },
    },
  });
}
