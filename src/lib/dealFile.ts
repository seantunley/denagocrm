/**
 * The deal file's checklist: what every deal must have on file (Sean, 2026-11-09) —
 * "Quote, Invoice, Supplier Quote, Supplier Invoice, Customer Proof of Payment,
 * Supplier Proof of payment. Could be multiple suppliers like OEM, delivery company,
 * wrapping etc" and "Delivery Paper needs to be in the deal file".
 *
 * Pure: the page loads the deal's quotes and documents (every quote on the lead) and
 * this says what is there and what is missing. A CRM tag counts as well as the type
 * a person chose, so paperwork filed on the deliveries board ("pop", "invoice",
 * "delivery-note") ticks the same boxes as an upload labelled by hand.
 */

export const CUSTOMER_INVOICE_TYPE = "Customer invoice";
export const CUSTOMER_POP_TYPE = "Proof of payment — customer";
/** Asked for once per supplier on the deal. */
export const SUPPLIER_DOCUMENT_TYPES = ["Supplier quote", "Supplier invoice", "Proof of payment — supplier"] as const;

export type DealFileQuote = {
  number: number;
  status: string;
  invoicedAt: Date | null;
  /** Set when the customer signed the delivery note at handover — the delivery paper exists. */
  deliverySignatureRef: string | null;
};

export type DealFileDocument = {
  tag: string | null;
  vendorId: string | null;
  vendorName: string | null;
};

export type ChecklistItem = { key: string; label: string; done: boolean; detail: string };

const same = (a: string | null | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

export const isSupplierDocumentType = (tag: string | null | undefined): boolean =>
  SUPPLIER_DOCUMENT_TYPES.some((type) => same(tag, type));

export function dealFileChecklist(
  quotes: readonly DealFileQuote[],
  documents: readonly DealFileDocument[],
  /** The workspace's document types: a checklist type missing from it can never be ticked, so it says so. */
  types: readonly string[],
): ChecklistItem[] {
  const has = (...tags: string[]) => documents.some((doc) => tags.some((tag) => same(doc.tag, tag)));
  const offMenu = (type: string) =>
    types.some((listed) => same(listed, type)) ? null : `Add “${type}” to Settings → Document types to file it.`;

  const sent = quotes.filter((quote) => quote.status !== "draft");
  const items: ChecklistItem[] = [
    {
      key: "quote",
      label: "Quote",
      done: sent.length > 0,
      detail: sent.length ? sent.map((quote) => `Q-${quote.number} ${quote.status}`).join(", ") : quotes.length ? "Only drafts so far" : "No quote yet",
    },
    {
      key: "invoice",
      label: "Invoice",
      done: quotes.some((quote) => quote.invoicedAt) || has("invoice", CUSTOMER_INVOICE_TYPE),
      detail: "Issued on the deliveries board, or uploaded as “Customer invoice”",
    },
    {
      key: "customer-pop",
      label: "Customer proof of payment",
      done: has("pop", CUSTOMER_POP_TYPE),
      detail: offMenu(CUSTOMER_POP_TYPE) ?? "Recorded with the deposit, or uploaded",
    },
    {
      key: "delivery",
      label: "Delivery paperwork",
      done: has("delivery-note") || quotes.some((quote) => quote.deliverySignatureRef),
      detail: "Filed when delivery is scheduled, or the delivery note signed at handover",
    },
  ];

  // One set per supplier named on any of the deal's documents; none yet → the set unnamed, all missing.
  const suppliers = new Map<string, string>();
  for (const doc of documents) if (doc.vendorId) suppliers.set(doc.vendorId, doc.vendorName ?? "Supplier");
  const supplierList = suppliers.size ? [...suppliers] : [[null, null] as const];
  for (const [vendorId, vendorName] of supplierList) {
    for (const type of SUPPLIER_DOCUMENT_TYPES) {
      items.push({
        key: `${vendorId ?? "none"}:${type}`,
        label: vendorName ? `${type} — ${vendorName}` : type,
        // With no supplier named anywhere, a file of the type still counts (filed before suppliers existed).
        done: documents.some((doc) => doc.vendorId === vendorId && same(doc.tag, type)),
        detail: offMenu(type) ?? (vendorName ? `Upload with ${vendorName} as the supplier` : "Upload it with the supplier chosen"),
      });
    }
  }
  return items;
}
