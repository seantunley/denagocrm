"use client";

import { useState } from "react";
import { isSupplierOnlyType, mayBeSupplierPaper } from "@/lib/dealFile";

type Vendor = { id: string; name: string };

/**
 * The supplier choice — shown only for a type on a supplier list. REQUIRED only for a type whose name says supplier
 * ("Supplier invoice"); for any other (an ID document a delivery company is asked for) it is optional, and left
 * empty the document is the customer's (review of #1059).
 */
function SupplierSelect({ vendors, current, required }: { vendors: readonly Vendor[]; current?: Vendor | null; required: boolean }) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {required ? "Supplier" : "From a supplier?"}
      <select name="vendorId" defaultValue={current?.id ?? ""} required={required} className="input h-9 text-sm">
        {required
          ? <option value="" disabled>{vendors.length ? "Choose the supplier" : "No suppliers yet — Settings → Suppliers"}</option>
          : <option value="">No — the customer&apos;s</option>}
        {current && !vendors.some((vendor) => vendor.id === current.id) && <option value={current.id}>{current.name} (deleted)</option>}
        {vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}
      </select>
    </label>
  );
}

/**
 * Relabelling a filed document: its type, and its supplier when the type is a supplier one.
 * Any other type sends an empty supplier, so a file relabelled away from "Supplier invoice"
 * stops counting for that supplier.
 */
export function DocumentLabelFields({ types, supplierTypes, current, vendors, currentVendor }: {
  types: readonly string[];
  /** Types on any supplier list (lib/dealFileConfig workspaceSupplierTypes) — those offer the supplier box. */
  supplierTypes: readonly string[];
  current: string;
  vendors: readonly Vendor[];
  currentVendor: Vendor | null;
}) {
  const [label, setLabel] = useState(current);
  return (
    <>
      <label className="grid gap-1 text-xs text-muted-foreground">
        What is it?
        <select name="label" value={label} onChange={(event) => setLabel(event.target.value)} className="input h-9 text-sm">
          <option value="">Not labelled</option>
          {types.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
      </label>
      {mayBeSupplierPaper(label, supplierTypes)
        ? <SupplierSelect key={label} vendors={vendors} current={currentVendor} required={isSupplierOnlyType(label)} />
        : <input type="hidden" name="vendorId" value="" />}
    </>
  );
}

/**
 * What the document is, which quote it belongs to, and which supplier it is from —
 * the choices on the upload form (Documents tab, deal file).
 *
 * A client component for one reason: an upload is filed against EXACTLY ONE
 * record (uploadDocument refuses a form naming two). Choosing a quote therefore
 * has to REPLACE the customer as the target, not sit beside it — so the hidden
 * target field follows the dropdown.
 */
export default function DocumentUploadFields({
  types,
  supplierTypes,
  quotes,
  contactId,
  vendors,
  defaultQuoteId = "",
}: {
  /** The workspace's document types (Settings → Quotes → Document types). */
  types: readonly string[];
  /** Types on any supplier list — those offer the supplier box (required only when the name says supplier). */
  supplierTypes: readonly string[];
  /** The customer's quotes to file against. Omit where there are none to choose (vehicle, job card). */
  quotes?: readonly { id: string; label: string }[];
  /** Offers "The customer (no quote)". Without it (the deal file) a quote is always the target. */
  contactId?: string;
  /** The workspace's suppliers (Settings → Suppliers). A supplier quote, invoice or proof of payment must name one. */
  vendors?: readonly Vendor[];
  defaultQuoteId?: string;
}) {
  const [quoteId, setQuoteId] = useState(defaultQuoteId);
  const [label, setLabel] = useState("");
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="grid gap-1 text-xs text-muted-foreground">
        What is it?
        <select name="label" value={label} onChange={(event) => setLabel(event.target.value)} className="input h-9 text-sm">
          <option value="">Not labelled</option>
          {types.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
      </label>
      {/* Only for a supplier's paper — the deal file asks for those per supplier. */}
      {vendors && mayBeSupplierPaper(label, supplierTypes) && <SupplierSelect key={label} vendors={vendors} required={isSupplierOnlyType(label)} />}
      {quotes && quotes.length > 0 && (
        <label className="grid gap-1 text-xs text-muted-foreground">
          File against
          <select value={quoteId} onChange={(event) => setQuoteId(event.target.value)} className="input h-9 text-sm">
            {contactId && <option value="">The customer (no quote)</option>}
            {quotes.map((quote) => <option key={quote.id} value={quote.id}>{quote.label}</option>)}
          </select>
        </label>
      )}
      {/* One target only: the quote when one is chosen, otherwise the customer. */}
      {quoteId ? <input type="hidden" name="quoteId" value={quoteId} /> : contactId ? <input type="hidden" name="contactId" value={contactId} /> : null}
    </div>
  );
}
