/**
 * The deal file's checklist: what every deal must have on file. The owner changes the lists (Sean, 2026-11-10 —
 * DealFileConfig below; a supplier's own list on its row). What it started as (Sean, 2026-11-09) —
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
/** What each supplier is asked for until the owner changes it (Settings → Quotes → Deal file checklist). */
export const SUPPLIER_DOCUMENT_TYPES = ["Supplier quote", "Supplier invoice", "Proof of payment — supplier"] as const;

/* ── What the deal file asks for — the owner's to change (Sean, 2026-11-10: "different documents per supplier and
   the lists"). One setting holds the two defaults; a supplier's own list lives on its row (Vendor.requiredDocuments). */

export const DEAL_FILE_CHECKLIST_KEY = "DEAL_FILE_CHECKLIST";

/** The checks every deal can carry that look further than a document's label (a sent quote, an issued invoice…). */
export const DEAL_BUILTINS = [
  { id: "quote", label: "Quote" },
  { id: "invoice", label: "Invoice" },
  { id: "customer-pop", label: "Customer proof of payment" },
  { id: "delivery", label: "Delivery paperwork" },
] as const;
export type DealBuiltin = (typeof DEAL_BUILTINS)[number]["id"];

export type DealFileConfig = {
  /** The built-in checks every deal needs. */
  builtins: DealBuiltin[];
  /** Document types every deal needs besides — from the workspace's Document types. */
  dealTypes: string[];
  /** What each supplier on a deal is asked for, unless it has its own list. */
  supplierTypes: string[];
};

export const DEFAULT_DEAL_FILE_CONFIG: DealFileConfig = {
  builtins: DEAL_BUILTINS.map((builtin) => builtin.id),
  dealTypes: [],
  supplierTypes: [...SUPPLIER_DOCUMENT_TYPES],
};

const LIST_MAX = 40;

/** A list of document types as saved: strings, trimmed, no repeats (ignoring case), at most 40. Null = not a list. */
export function documentTypeList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const type = entry.trim().slice(0, 60);
    if (!type || seen.has(type.toLowerCase())) continue;
    seen.add(type.toLowerCase());
    out.push(type);
    if (out.length === LIST_MAX) break;
  }
  return out;
}

/** The saved setting → the checklist. Anything unreadable falls back to the default for that part only. */
export function parseDealFileConfig(raw: string | null | undefined): DealFileConfig {
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const saved = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const known = new Set<string>(DEAL_BUILTINS.map((builtin) => builtin.id));
  const builtins = Array.isArray(saved.builtins)
    ? DEAL_BUILTINS.map((builtin) => builtin.id).filter((id) => (saved.builtins as unknown[]).includes(id) && known.has(id))
    : [...DEFAULT_DEAL_FILE_CONFIG.builtins];
  return {
    builtins,
    // A supplier-only type is never a deal-wide line: its file always names a supplier, and the deal's own lines count
    // only files naming none — so it could never tick. Dropped here, it is gone for every reader and every saved value.
    dealTypes: (documentTypeList(saved.dealTypes) ?? []).filter((type) => !isSupplierOnlyType(type)),
    supplierTypes: documentTypeList(saved.supplierTypes) ?? [...DEFAULT_DEAL_FILE_CONFIG.supplierTypes],
  };
}

/**
 * The types ticked on a form, kept only when they are on the workspace's Document types (a dropdown, never typed),
 * in that list's order.
 */
export function tickedTypes(posted: readonly unknown[], types: readonly string[]): string[] {
  const ticked = new Set(posted.map((value) => String(value)));
  return types.filter((type) => ticked.has(type));
}

/** What one supplier is asked for: its own list when it has one (even empty), otherwise the default. */
export function typesForSupplier(config: DealFileConfig, own: unknown): string[] {
  return documentTypeList(own) ?? config.supplierTypes;
}

/**
 * Every type on any supplier list in this workspace — the default list and every supplier's own. An upload of one
 * OFFERS a supplier box (mayBeSupplierPaper); it never makes a document a supplier's by itself.
 */
export function supplierDocumentTypes(config: DealFileConfig, vendorLists: readonly unknown[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const type of [config.supplierTypes, ...vendorLists.map((list) => documentTypeList(list) ?? [])].flat()) {
    if (seen.has(type.toLowerCase())) continue;
    seen.add(type.toLowerCase());
    out.push(type);
  }
  return out;
}

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
  /** The supplier's own list (Vendor.requiredDocuments), for a supplier only named on a document. */
  vendorRequiredDocuments?: unknown;
};

export type ChecklistItem = {
  key: string;
  label: string;
  done: boolean;
  detail: string;
  /** Set on a supplier's line: who it is asked of (null = no supplier named yet) and what. */
  supplier?: { vendorId: string | null; documentType: string };
};

const same = (a: string | null | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

/*
 * WHOSE PAPER IT IS COMES FROM THE DOCUMENT, NOT ITS TYPE (review of #1059). A type on some supplier's list can be the
 * customer's paper too — a transport company asked for an ID document must not turn every customer ID into a
 * supplier's. So: a document is a supplier's when it NAMES a supplier (Document.vendorId). The type only decides
 *  - whether the upload OFFERS a supplier box (any type on any supplier list — optional), and
 *  - whether it REQUIRES one: only the three types whose very name says supplier (SUPPLIER_DOCUMENT_TYPES).
 */

/** A type that is always a supplier's paper — its name says so ("Supplier quote" …). It must name the supplier. */
export const isSupplierOnlyType = (tag: string | null | undefined): boolean =>
  SUPPLIER_DOCUMENT_TYPES.some((type) => same(tag, type));

/** Whether an upload of this type offers the (optional) supplier box — `supplierTypes` from supplierDocumentTypes. */
export const mayBeSupplierPaper = (tag: string | null | undefined, supplierTypes: readonly string[]): boolean =>
  isSupplierOnlyType(tag) || supplierTypes.some((type) => same(tag, type));
export type PartySection<T> = { key: string; label: string; docs: T[] };

/**
 * A quote's papers split by who they are with (Sean, 2026-11-09): the customer's side first, then each supplier's
 * under its name (A–Z) — by the supplier the document names — then supplier-only papers with no supplier named
 * (filed with the Suppliers module off, or before suppliers existed). Order within a section is kept.
 */
export function partiesOf<T extends { tag?: string | null; vendor?: { id: string; name: string } | null }>(docs: T[]): (PartySection<T> & { supplier: boolean })[] {
  const customer = docs.filter((doc) => !doc.vendor && !isSupplierOnlyType(doc.tag));
  const named = new Map<string, PartySection<T>>();
  const unnamed: T[] = [];
  for (const doc of docs) {
    if (doc.vendor) {
      const section = named.get(doc.vendor.id) ?? { key: doc.vendor.id, label: doc.vendor.name, docs: [] };
      section.docs.push(doc);
      named.set(doc.vendor.id, section);
    } else if (isSupplierOnlyType(doc.tag)) unnamed.push(doc);
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
  /** What the owner asks for (Settings → Quotes → Deal file checklist). */
  config: DealFileConfig,
  /**
   * The suppliers the deal declares (DealVendor) — asked for even before any of their papers arrive. A supplier
   * named on a document counts too, declared or not. `requiredDocuments`: its own list (null = the default).
   */
  declaredVendors: readonly { id: string; name: string; requiredDocuments?: unknown }[] = [],
  /** The Suppliers module: off, there is no supplier to choose, so the hint names only the document type. */
  suppliersOn = true,
): ChecklistItem[] {
  // The customer's side counts the customer's papers only: a document naming a supplier is that supplier's (review of
  // #1059 — a delivery company's ID document is not the customer's ID).
  const has = (...tags: string[]) => documents.some((doc) => !doc.vendorId && tags.some((tag) => same(doc.tag, tag)));
  const offMenu = (type: string) =>
    types.some((listed) => same(listed, type)) ? null : `Add “${type}” to Settings → Document types to file it.`;

  const sent = quotes.filter((quote) => quote.status !== "draft");
  const builtins: Record<DealBuiltin, ChecklistItem> = {
    quote: {
      key: "quote",
      label: "Quote",
      done: sent.length > 0,
      detail: sent.length ? sent.map((quote) => `Q-${quote.number} ${quote.status}`).join(", ") : quotes.length ? "Only drafts so far" : "No quote yet",
    },
    invoice: {
      key: "invoice",
      label: "Invoice",
      done: quotes.some((quote) => quote.invoicedAt) || has("invoice", CUSTOMER_INVOICE_TYPE),
      detail: "Issued on the deliveries board, or uploaded as “Customer invoice”",
    },
    "customer-pop": {
      key: "customer-pop",
      label: "Customer proof of payment",
      done: has("pop", CUSTOMER_POP_TYPE),
      detail: offMenu(CUSTOMER_POP_TYPE) ?? "Recorded with the deposit, or uploaded",
    },
    delivery: {
      key: "delivery",
      label: "Delivery paperwork",
      done: has("delivery-note") || quotes.some((quote) => quote.deliverySignatureRef),
      detail: "Filed when delivery is scheduled, or the delivery note signed at handover",
    },
  };
  const items: ChecklistItem[] = [
    ...config.builtins.map((id) => builtins[id]),
    ...config.dealTypes.map((type) => ({
      key: `type:${type}`,
      label: type,
      done: has(type),
      detail: offMenu(type) ?? `Upload it as “${type}”`,
    })),
  ];

  // One set per supplier on the deal — declared, or named on any of its documents; none → the default set unnamed.
  // Each supplier is asked for ITS list (Vendor.requiredDocuments), or the default one.
  const suppliers = new Map<string, { name: string; own: unknown }>();
  for (const vendor of declaredVendors) suppliers.set(vendor.id, { name: vendor.name, own: vendor.requiredDocuments ?? null });
  for (const doc of documents) {
    if (doc.vendorId && !suppliers.has(doc.vendorId)) suppliers.set(doc.vendorId, { name: doc.vendorName ?? "Supplier", own: doc.vendorRequiredDocuments ?? null });
  }
  const supplierList: [string | null, { name: string | null; own: unknown }][] = suppliers.size ? [...suppliers] : [[null, { name: null, own: null }]];
  for (const [vendorId, { name: vendorName, own }] of supplierList) {
    for (const type of suppliersOn ? typesForSupplier(config, own) : config.supplierTypes) {
      items.push({
        key: `${vendorId ?? "none"}:${type}`,
        label: vendorName ? `${type} — ${vendorName}` : type,
        // With no supplier named anywhere, a file of the type still counts (filed before suppliers existed).
        done: documents.some((doc) => doc.vendorId === vendorId && same(doc.tag, type)),
        detail:
          offMenu(type) ??
          (!suppliersOn ? `Upload it as “${type}”` : vendorName ? `Upload with ${vendorName} as the supplier` : "Upload it with the supplier chosen"),
        supplier: { vendorId, documentType: type },
      });
    }
  }
  return items;
}
