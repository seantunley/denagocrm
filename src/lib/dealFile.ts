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
export type PartySection<T> = { key: string; label: string; docs: T[] };

/**
 * A quote's papers split by who they are with (Sean, 2026-11-09): the customer's side first, then each supplier's
 * under its name (A–Z), then supplier papers with no supplier named (e.g. filed with the Suppliers module off).
 * Order within a section is kept. `supplier` is false for the customer section.
 */
export function partiesOf<T extends { tag?: string | null; vendor?: { id: string; name: string } | null }>(docs: T[]): (PartySection<T> & { supplier: boolean })[] {
  const customer = docs.filter((doc) => !doc.vendor && !isSupplierDocumentType(doc.tag));
  const named = new Map<string, PartySection<T>>();
  const unnamed: T[] = [];
  for (const doc of docs) {
    if (doc.vendor) {
      const section = named.get(doc.vendor.id) ?? { key: doc.vendor.id, label: doc.vendor.name, docs: [] };
      section.docs.push(doc);
      named.set(doc.vendor.id, section);
    } else if (isSupplierDocumentType(doc.tag)) unnamed.push(doc);
  }
  return [
    ...(customer.length ? [{ key: "customer", label: "Customer", docs: customer, supplier: false }] : []),
    ...[...named.values()].sort((a, b) => a.label.localeCompare(b.label)).map((section) => ({ ...section, label: `Supplier · ${section.label}`, supplier: true })),
    ...(unnamed.length ? [{ key: "supplier:none", label: "Suppliers", docs: unnamed, supplier: true }] : []),
  ];
}

/** A supplier's quote: its prices become the customer quote's costs (actions/quoteCosts.ts). */
export const isSupplierQuote = (tag: string | null | undefined): boolean => same(tag, SUPPLIER_DOCUMENT_TYPES[0]);

export function dealFileChecklist(
  quotes: readonly DealFileQuote[],
  documents: readonly DealFileDocument[],
  /** The workspace's document types: a checklist type missing from it can never be ticked, so it says so. */
  types: readonly string[],
  /**
   * The suppliers the deal declares (DealVendor) — asked for even before any of their papers arrive.
   * A supplier named on a document counts too, declared or not.
   */
  declaredVendors: readonly { id: string; name: string }[] = [],
  /** The Suppliers module: off, there is no supplier to choose, so the hint names only the document type. */
  suppliersOn = true,
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

  // One set per supplier on the deal — declared, or named on any of its documents; none → the set unnamed, all missing.
  const suppliers = new Map<string, string>();
  for (const vendor of declaredVendors) suppliers.set(vendor.id, vendor.name);
  for (const doc of documents) if (doc.vendorId && !suppliers.has(doc.vendorId)) suppliers.set(doc.vendorId, doc.vendorName ?? "Supplier");
  const supplierList = suppliers.size ? [...suppliers] : [[null, null] as const];
  for (const [vendorId, vendorName] of supplierList) {
    for (const type of SUPPLIER_DOCUMENT_TYPES) {
      items.push({
        key: `${vendorId ?? "none"}:${type}`,
        label: vendorName ? `${type} — ${vendorName}` : type,
        // With no supplier named anywhere, a file of the type still counts (filed before suppliers existed).
        done: documents.some((doc) => doc.vendorId === vendorId && same(doc.tag, type)),
        detail:
          offMenu(type) ??
          (!suppliersOn ? `Upload it as “${type}”` : vendorName ? `Upload with ${vendorName} as the supplier` : "Upload it with the supplier chosen"),
      });
    }
  }
  return items;
}
