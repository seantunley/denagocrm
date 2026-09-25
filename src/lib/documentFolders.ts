/**
 * The Documents page's folders, derived from the records every file is already
 * filed against — nobody files anything by hand.
 *
 *   Customers › Gavin Tagg › Quote Q-1010
 *   Customers › Gavin Tagg › General
 *   Company files
 *
 * Every Document already points at a customer, vehicle, job card or quote (or at
 * nothing, for company files). The page used to ignore that and list every file
 * newest-first, which is why it read as an unorganised pile. This module turns
 * the links into a tree.
 *
 * Pure — no Prisma, no session — so the placement rules, which are also a
 * permission rule (see `placeDocument`), are executed by tests rather than read.
 */

/**
 * A document's links — or a GROUP of documents sharing the same links, with
 * `count` saying how many. The page counts its tree from grouped rows so that
 * no file is left out however many there are (see the Documents page).
 */
export type DocFacts = {
  contactId: string | null;
  vehicleId: string | null;
  jobCardId: string | null;
  quoteId: string | null;
  tag: string | null;
  /** Only needed for the Recent folder; grouped rows leave it out. */
  createdAt?: Date;
  /** How many documents this row stands for. Defaults to one. */
  count?: number;
};

/**
 * What the page knows about the records files are filed against.
 *
 * EVERY MAP HOLDS ONLY RECORDS THE VIEWER MAY OPEN — customers, vehicles, job
 * cards and quotes alike. A document is visible if ANY of its links is, so a
 * viewer can see a file whose customer or quote is hidden from them. Naming a
 * folder after a hidden customer would disclose the name; titling one "Quote
 * Q-1010" would disclose the quote. So a link to a record the viewer cannot
 * open is treated as if it were not there (see `placeDocument`).
 */
export type RecordLabels = {
  contacts: ReadonlyMap<string, string>;
  vehicles: ReadonlyMap<string, { label: string; contactId: string | null }>;
  jobCards: ReadonlyMap<string, { number: number; contactId: string | null }>;
  quotes: ReadonlyMap<string, { number: number; contactId: string | null }>;
};

/** A sub-folder inside a customer: `general`, `quote:<id>`, `vehicle:<id>` or `jobcard:<id>`. */
export type SubKey = string;

export type Placement =
  | { kind: "company" }
  | { kind: "customer"; customerId: string; sub: SubKey; subLabel: string }
  | { kind: "other"; sub: SubKey; subLabel: string };

/**
 * THE MOST SPECIFIC RECORD DECIDES THE FOLDER.
 *
 * A file can carry more than one link, and most do: delivery photos, signing
 * paperwork, proofs of payment and invoices are all written with BOTH the
 * customer and the quote set (measured on production, 25 September 2026 — every
 * tagged document). The first version checked the customer first, so all of
 * that landed in "General" and the quote folders sat nearly empty.
 *
 * So the sub-folder is the most specific record present — quote, then job card,
 * then vehicle — and "General" only when the customer is all there is. The
 * customer is the file's own, falling back to the record's.
 */
export const RESTRICTED_SUB = "restricted";

export function placeDocument(doc: DocFacts, labels: RecordLabels): Placement {
  // Only links to records the viewer may open count (see RecordLabels).
  const quote = doc.quoteId ? labels.quotes.get(doc.quoteId) : undefined;
  const jobCard = doc.jobCardId ? labels.jobCards.get(doc.jobCardId) : undefined;
  const vehicle = doc.vehicleId ? labels.vehicles.get(doc.vehicleId) : undefined;

  let recordCustomerId: string | null = null;
  let sub: SubKey;
  let subLabel: string;

  if (quote && doc.quoteId) {
    recordCustomerId = quote.contactId;
    sub = `quote:${doc.quoteId}`;
    subLabel = `Quote Q-${quote.number}`;
  } else if (jobCard && doc.jobCardId) {
    recordCustomerId = jobCard.contactId;
    sub = `jobcard:${doc.jobCardId}`;
    subLabel = `Job card #${jobCard.number}`;
  } else if (vehicle && doc.vehicleId) {
    recordCustomerId = vehicle.contactId;
    sub = `vehicle:${doc.vehicleId}`;
    subLabel = vehicle.label;
  } else if (doc.contactId && labels.contacts.has(doc.contactId)) {
    sub = "general";
    subLabel = "General";
  } else if (doc.contactId || doc.quoteId || doc.jobCardId || doc.vehicleId) {
    // Filed on records, none of which this viewer may open — reachable, for
    // example, as the uploader of a file on a record they have since lost. Name
    // none of them.
    return { kind: "other", sub: RESTRICTED_SUB, subLabel: "On records you can't open" };
  } else {
    return { kind: "company" };
  }
  const customerId = doc.contactId ?? recordCustomerId;

  // Only a customer the viewer may see gets a named folder.
  if (customerId && labels.contacts.has(customerId)) {
    return { kind: "customer", customerId, sub, subLabel };
  }
  return { kind: "other", sub, subLabel };
}

/* ── The current folder, from the URL ─────────────────────────────── */

export type Folder =
  | { kind: "all" }
  | { kind: "recent" }
  | { kind: "company" }
  | { kind: "other"; sub: SubKey | null }
  | { kind: "customer"; customerId: string; sub: SubKey | null };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUB = /^(general|restricted|(quote|vehicle|jobcard):[A-Za-z0-9_-]{1,64})$/;

/**
 * `?folder=` and `?sub=` into a Folder. Anything malformed is "all files" — a
 * hand-edited URL shows everything the viewer may see, never an error, and
 * never more than that: the folder only narrows a list that was already
 * permission-filtered.
 */
export function parseFolder(folder: string | undefined, sub: string | undefined): Folder {
  const cleanSub = sub && SUB.test(sub) ? sub : null;
  if (folder === "recent") return { kind: "recent" };
  if (folder === "company") return { kind: "company" };
  if (folder === "other") return { kind: "other", sub: cleanSub };
  if (folder?.startsWith("customer:")) {
    const customerId = folder.slice("customer:".length);
    if (ID.test(customerId)) return { kind: "customer", customerId, sub: cleanSub };
  }
  return { kind: "all" };
}

export function folderHref(folder: Folder, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  if (folder.kind === "recent" || folder.kind === "company") params.set("folder", folder.kind);
  if (folder.kind === "other") {
    params.set("folder", "other");
    if (folder.sub) params.set("sub", folder.sub);
  }
  if (folder.kind === "customer") {
    params.set("folder", `customer:${folder.customerId}`);
    if (folder.sub) params.set("sub", folder.sub);
  }
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  const query = params.toString();
  return query ? `/documents?${query}` : "/documents";
}

export const RECENT_DAYS = 30;

export function inFolder(doc: DocFacts, folder: Folder, labels: RecordLabels, now = new Date()): boolean {
  if (folder.kind === "all") return true;
  if (folder.kind === "recent") {
    return Boolean(doc.createdAt) && now.getTime() - doc.createdAt!.getTime() <= RECENT_DAYS * 86_400_000;
  }
  const placement = placeDocument(doc, labels);
  if (folder.kind === "company") return placement.kind === "company";
  if (folder.kind === "other") {
    return placement.kind === "other" && (!folder.sub || placement.sub === folder.sub);
  }
  return (
    placement.kind === "customer" &&
    placement.customerId === folder.customerId &&
    (!folder.sub || placement.sub === folder.sub)
  );
}

/* ── The tree ──────────────────────────────────────────────────────── */

export type SubFolder = { key: SubKey; label: string; count: number };
export type CustomerFolder = { id: string; name: string; count: number; subs: SubFolder[] };

export type FolderTree = {
  all: number;
  recent: number;
  company: number;
  customers: CustomerFolder[];
  other: { count: number; subs: SubFolder[] };
};

export function buildFolderTree(docs: readonly DocFacts[], labels: RecordLabels, now = new Date()): FolderTree {
  const customers = new Map<string, { count: number; subs: Map<SubKey, SubFolder> }>();
  const other = { count: 0, subs: new Map<SubKey, SubFolder>() };
  let company = 0;
  let recent = 0;

  const addSub = (subs: Map<SubKey, SubFolder>, key: SubKey, label: string, n: number) => {
    const existing = subs.get(key);
    if (existing) existing.count += n;
    else subs.set(key, { key, label, count: n });
  };

  let all = 0;
  for (const doc of docs) {
    const n = doc.count ?? 1;
    all += n;
    if (doc.createdAt && now.getTime() - doc.createdAt.getTime() <= RECENT_DAYS * 86_400_000) recent += n;
    const placement = placeDocument(doc, labels);
    if (placement.kind === "company") {
      company += n;
    } else if (placement.kind === "other") {
      other.count += n;
      addSub(other.subs, placement.sub, placement.subLabel, n);
    } else {
      const folder = customers.get(placement.customerId) ?? { count: 0, subs: new Map() };
      folder.count += n;
      addSub(folder.subs, placement.sub, placement.subLabel, n);
      customers.set(placement.customerId, folder);
    }
  }

  // "General" first, then the records in label order — Q-1009 before Q-1010.
  const orderSubs = (subs: Map<SubKey, SubFolder>) =>
    [...subs.values()].sort((a, b) =>
      a.key === "general" ? -1 : b.key === "general" ? 1 : a.label.localeCompare(b.label, "en", { numeric: true }),
    );

  return {
    all,
    recent,
    company,
    customers: [...customers.entries()]
      .map(([id, folder]) => ({
        id,
        name: labels.contacts.get(id) ?? "Customer",
        count: folder.count,
        subs: orderSubs(folder.subs),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
    other: { count: other.count, subs: orderSubs(other.subs) },
  };
}

/* ── Uploading into the open folder ────────────────────────────────── */

/**
 * The record a file dropped into this folder is filed against, as the form
 * fields `uploadDocument` reads — or null where the folder does not say where a
 * file belongs (the whole of Other records, which spans many records).
 *
 * All files and Recent upload into Company files. That is what an upload from
 * the old flat page did — it was filed against nothing — and the phone's quick
 * "capture a document" relies on it, so it is kept rather than taken away.
 *
 * This only PROPOSES a target. `uploadDocument` authorises it server-side
 * against the viewer's access to that record, exactly as for any other upload,
 * so a crafted URL cannot file a document anywhere the viewer could not already.
 */
export type UploadTarget =
  | { kind: "company" }
  | { kind: "record"; field: "contactId" | "vehicleId" | "jobCardId" | "quoteId"; id: string };

export function uploadTargetFor(folder: Folder): UploadTarget | null {
  if (folder.kind === "company" || folder.kind === "all" || folder.kind === "recent") return { kind: "company" };
  const sub = folder.kind === "customer" || folder.kind === "other" ? folder.sub : null;
  if (sub?.startsWith("quote:")) return { kind: "record", field: "quoteId", id: sub.slice(6) };
  if (sub?.startsWith("vehicle:")) return { kind: "record", field: "vehicleId", id: sub.slice(8) };
  if (sub?.startsWith("jobcard:")) return { kind: "record", field: "jobCardId", id: sub.slice(8) };
  // A customer's own folder, or its General sub-folder: filed on the customer.
  if (folder.kind === "customer") return { kind: "record", field: "contactId", id: folder.customerId };
  return null;
}
