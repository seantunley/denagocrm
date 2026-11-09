import Link from "next/link";
import { uploadDocument, deleteDocument, relabelDocument } from "@/app/actions/documents";
import ConfirmDelete from "@/components/ConfirmDelete";
import DocumentUploadFields, { DocumentLabelFields } from "@/components/DocumentUploadFields";
import ModalTrigger from "@/components/Modal";
import { DOCUMENT_TYPES_KEY, isPersonLabel, parseDocumentTypes, SYSTEM_TAG_LABELS } from "@/lib/documentLabels";
import { getSetting, getRegionalSettings } from "@/lib/settings";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { isSupplierInvoice } from "@/lib/supplierInvoiceRules";
import { confirmSupplierInvoice, readSupplierInvoiceNow } from "@/app/actions/supplierInvoices";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import QuoteRowActions from "@/components/quotes/QuoteRowActions";
import { StatusPill } from "@/components/visual-system";
import { formatDate, formatZAR } from "@/lib/format";
import { withCurrency } from "@/lib/currencyRules";
import { isSupplierQuote, partiesOf } from "@/lib/dealFile";
import { quotePricing, type PricedLine } from "@/lib/pricing";
import { saveQuoteLineCosts } from "@/app/actions/quoteCosts";
import { requireUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { FileText, Tag, Upload } from "lucide-react";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type Doc = {
  id: string;
  fileName: string;
  sizeBytes: number;
  createdAt: Date;
  tag?: string | null;
  uploadedBy: { name: string };
  /**
   * Whose record this file is filed against. Only set where the panel shows an
   * AGGREGATE — the fleet page pools the documents of every contact in the fleet,
   * and an aggregated list with no attribution is unreadable. Omitted (and
   * therefore not rendered) on the single-contact, vehicle and job-card panels,
   * where the owner is the page you are already on.
   */
  ownerLabel?: string | null;
  /**
   * The supplier it is from. Undefined where the page didn't load it: that row then
   * offers no supplier choice when relabelled, and the one on file is kept.
   */
  vendor?: { id: string; name: string } | null;
};

/** A quote and every piece of paper that belongs to it. */
export type QuoteGroup = {
  id: string;
  number: number;
  status: string;
  signed: boolean;
  superseded: boolean;
  totalCents: number;
  /** NULL = the base currency. */
  currency: string | null;
  createdAt: Date;
  documents: Doc[];
  /**
   * Photos taken in this quote's delivery checklist (lib/dealFileData.ts handoverPhotos). Shown under the quote's
   * papers — where people look for the handover — not in a box below every quote, where they went unseen.
   */
  handoverPhotos?: { id: string; src: string | null; step: string; takenAt: Date }[];
};

/** What each CRM-written tag means to someone reading the tab (shared with the deal-file ZIP). */
const TAG_LABELS = SYSTEM_TAG_LABELS;

/**
 * Paperwork reads in the order the deal happens — signed contract, invoice,
 * payment, delivery — not newest-upload-first, which showed the delivery note
 * above the contract it was delivering against.
 */
const TAG_ORDER = [
  "signed",
  "invoice",
  "pop",
  "delivery-note",
  "delivery-signature",
  "delivery-photo",
];

function byLifecycle(a: Doc, b: Doc): number {
  const rank = (doc: Doc) => {
    const index = doc.tag ? TAG_ORDER.indexOf(doc.tag) : -1;
    return index === -1 ? TAG_ORDER.length : index;
  };
  return rank(a) - rank(b) || b.createdAt.getTime() - a.createdAt.getTime();
}

function statusTone(status: string): "neutral" | "success" | "danger" | "info" {
  if (status === "accepted") return "success";
  if (status === "declined") return "danger";
  if (status === "sent") return "info";
  return "neutral";
}

/** `vendors` null: the Suppliers module is off — no supplier is shown or offered on the row. */
type InvoiceRow = { invoiceNumber: string | null; invoiceDate: Date | null; dueDate: Date | null; totalCents: number | null; currency: string | null; status: string };
/** Supplier invoice documents on the list → what was read from each (null: nothing yet). Absent: not an invoice. */
type InvoiceMap = Map<string, InvoiceRow | null>;
const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : "");

/**
 * Under a supplier invoice: what was read from it, for a person to confirm or correct (lib/supplierInvoiceReader.ts).
 * Nothing read is used until someone presses Confirm; a confirmed one shows as a line, with Edit.
 */
function InvoiceBox({ documentId, revalidate, invoice, money }: { documentId: string; revalidate: string; invoice: InvoiceRow | null; money: (cents: number, currency: string | null) => string }) {
  const summary = invoice
    ? [invoice.invoiceNumber, invoice.invoiceDate ? formatDate(invoice.invoiceDate) : null, invoice.totalCents !== null ? money(invoice.totalCents, invoice.currency) : null, invoice.dueDate ? `due ${formatDate(invoice.dueDate)}` : null].filter(Boolean).join(" · ")
    : "";
  const form = (
    <SaveForm action={confirmSupplierInvoice.bind(null, documentId, revalidate)} success="Invoice confirmed" resetOnSuccess={false} className="mt-1.5 grid gap-1.5 sm:grid-cols-5">
      <input name="invoiceNumber" defaultValue={invoice?.invoiceNumber ?? ""} placeholder="Invoice no." aria-label="Invoice number" className="input h-8 text-xs" />
      <input name="invoiceDate" type="date" defaultValue={day(invoice?.invoiceDate ?? null)} aria-label="Invoice date" className="input h-8 text-xs" />
      <input name="dueDate" type="date" defaultValue={day(invoice?.dueDate ?? null)} aria-label="Due date" className="input h-8 text-xs" />
      <input name="total" defaultValue={invoice?.totalCents != null ? (invoice.totalCents / 100).toFixed(2) : ""} placeholder="Total" aria-label="Total" className="input h-8 text-xs" />
      <div className="flex gap-1.5">
        <input name="currency" defaultValue={invoice?.currency ?? ""} placeholder="ZAR" maxLength={3} aria-label="Currency" className="input h-8 w-16 text-xs uppercase" />
        <SaveButton className="btn-primary btn-sm">Confirm</SaveButton>
      </div>
    </SaveForm>
  );
  if (invoice?.status === "confirmed") {
    return (
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer"><span className="text-emerald-400">Invoice confirmed</span>{summary ? ` · ${summary}` : ""} — <span className="underline">edit</span></summary>
        {form}
      </details>
    );
  }
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {invoice?.status === "read" ? <>Read from the invoice — <strong className="text-foreground">check it and confirm</strong>{summary ? `: ${summary}` : ""}</> : invoice?.status === "unreadable" ? "Couldn't read this invoice — fill it in below." : "Not read yet."}
        </span>
        {invoice?.status !== "read" && (
          <SaveForm action={readSupplierInvoiceNow.bind(null, documentId, revalidate)}>
            <SaveButton className="text-xs font-medium text-primary hover:underline" pendingLabel="Reading…">Read invoice</SaveButton>
          </SaveForm>
        )}
      </div>
      {form}
    </div>
  );
}

function DocRow({ doc: row, revalidate, types, vendors, invoices, money }: {
  doc: Doc;
  revalidate: string;
  types: readonly string[];
  vendors: readonly { id: string; name: string }[] | null;
  invoices: InvoiceMap;
  money: (cents: number, currency: string | null) => string;
}) {
  const doc = vendors === null ? { ...row, vendor: undefined } : row;
  // What it IS leads: a type somebody chose ("Supplier quote") is the document's
  // name on this list, with the file name beneath. A tag the CRM wrote keeps its
  // wording and its place in the small print.
  const chosen = doc.tag && isPersonLabel(doc.tag) ? doc.tag : null;
  const system = doc.tag && !chosen ? TAG_LABELS[doc.tag] ?? null : null;
  // What the deal file's search box matches (DealFileSearch).
  const search = [doc.fileName, chosen, system, doc.vendor?.name, doc.uploadedBy.name].filter(Boolean).join(" ").toLowerCase();
  return (
    <li className="group flex flex-wrap items-center gap-3 py-2" data-search={search}>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/30 text-muted-foreground">
        <FileText className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <a
          href={`/api/files/${doc.id}`}
          className="block truncate text-sm font-medium text-orange-400 hover:underline"
          target="_blank"
        >
          {chosen ?? doc.fileName}
        </a>
        <p className="truncate text-xs text-slate-400">
          {chosen ? `${doc.fileName} · ` : ""}
          {system ? `${system} · ` : ""}
          {doc.vendor ? `${doc.vendor.name} · ` : ""}
          {humanSize(doc.sizeBytes)} · {formatDate(doc.createdAt)} · {doc.uploadedBy.name}
          {doc.ownerLabel ? ` · ${doc.ownerLabel}` : ""}
        </p>
      </div>
      {/* Only a label a person chose (or none yet) can be changed — never a tag the CRM wrote. */}
      {isPersonLabel(doc.tag) && (
        <ModalTrigger label={<><Tag className="size-3" />{chosen ? "Relabel" : "Label"}</>} title={`Label “${doc.fileName}”`} buttonClass="inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <SaveForm action={relabelDocument.bind(null, doc.id, revalidate)} success="Label saved" className="grid gap-3 p-4">
            {doc.vendor !== undefined ? (
              // The supplier appears only for a supplier quote, invoice or proof of payment.
              <DocumentLabelFields types={types} current={chosen && types.includes(chosen) ? chosen : ""} vendors={vendors ?? []} currentVendor={doc.vendor} />
            ) : (
              // This page didn't load suppliers: no supplier field, so the one on file is kept.
              <label className="grid gap-1 text-xs text-muted-foreground">
                What is it?
                <select name="label" defaultValue={chosen && types.includes(chosen) ? chosen : ""} className="input h-9 text-sm">
                  <option value="">Not labelled</option>
                  {types.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
            )}
            <SaveButton className="btn-primary btn-sm">Save label</SaveButton>
          </SaveForm>
        </ModalTrigger>
      )}
      <div className="opacity-0 group-hover:opacity-100">
        <ConfirmDelete
          action={deleteDocument.bind(null, doc.id, revalidate)}
          title={`Delete document “${doc.fileName}”?`}
          description="The document moves to the Trash and can be restored for 60 days."
          trigger="✕"
          triggerClass="cursor-pointer text-xs text-slate-600 hover:text-red-500"
        />
      </div>
      {invoices.has(doc.id) && (
        <div className="basis-full pl-11">
          <InvoiceBox documentId={doc.id} revalidate={revalidate} invoice={invoices.get(doc.id) ?? null} money={money} />
        </div>
      )}
    </li>
  );
}

type CostItem = PricedLine & { id: string; description: string; costCents: number };

/**
 * Under a quote with a supplier quote on file: each line's cost per unit, from the supplier's paper, and the
 * margin it gives. Internal — cost never reaches the customer's document.
 */
function QuoteCostsBox({ quoteId, items, taxInclusive, revalidate, money }: { quoteId: string; items: CostItem[]; taxInclusive: boolean; revalidate: string; money: (cents: number) => string }) {
  const pricing = quotePricing(items, [], { taxInclusive });
  return (
    <details className="mt-2 rounded-lg border border-border/70 bg-muted/20 p-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">
        <span className="font-medium text-foreground">Costs from supplier quotes</span>
        {pricing.costCents > 0
          ? <> · margin <span className="tabular-nums text-foreground">{money(pricing.marginCents)} · {pricing.marginPct}%</span> <span className="text-[10px] uppercase tracking-wider">internal</span></>
          : " · no costs entered yet"}
      </summary>
      <SaveForm action={saveQuoteLineCosts.bind(null, quoteId, revalidate)} success="Costs saved" resetOnSuccess={false} className="mt-2 grid gap-1.5">
        <p>Cost per unit from the supplier, <strong>excl. VAT</strong>, in the quote&apos;s currency. A blank box leaves that line as it is.</p>
        {items.map((item) => (
          <label key={item.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-foreground">{item.description}{item.qty !== 1 ? ` × ${item.qty}` : ""}</span>
            <input
              name={`cost_${item.id}`}
              defaultValue={item.costCents > 0 ? (item.costCents / 100).toFixed(2) : ""}
              placeholder="Cost"
              inputMode="decimal"
              aria-label={`Cost per unit for ${item.description}`}
              className="input h-8 w-32 text-right text-xs tabular-nums"
            />
          </label>
        ))}
        <SaveButton className="btn-primary btn-sm justify-self-end">Save costs</SaveButton>
      </SaveForm>
    </details>
  );
}

export default async function DocumentsPanel({
  documents,
  quoteGroups,
  contactId,
  vehicleId,
  jobCardId,
  revalidate,
  hideUpload = false,
  emptyText = "No documents uploaded.",
  quoteActions,
  title = "Documents",
  defaultQuoteId,
}: {
  title?: string;
  /** The deal file: upload goes against one of `quoteGroups` (this one first), never the customer. */
  defaultQuoteId?: string;
  documents: Doc[];
  /** Quote-by-quote grouping. Omit for the vehicle and job card panels. */
  quoteGroups?: QuoteGroup[];
  /** Offer Cancel / Duplicate on each quote heading; the caller's permissions. */
  quoteActions?: { canCancel: boolean; canDuplicate: boolean };
  contactId?: string;
  vehicleId?: string;
  jobCardId?: string;
  revalidate: string;
  /**
   * Drop the upload form. For AGGREGATE views (the fleet page) where there is no
   * single record to file a new document against: with no contactId/vehicleId/
   * jobCardId the form would happily upload a document linked to nothing, which
   * looks like it worked and files the paperwork nowhere.
   */
  hideUpload?: boolean;
  /** What to say when there is nothing to show. */
  emptyText?: string;
}) {
  const grouped = quoteGroups && quoteGroups.length > 0;
  // The workspace's document types (Settings → Quotes → Document types): the dropdown on upload and on Label.
  const types = parseDocumentTypes(await getSetting(DOCUMENT_TYPES_KEY));
  // A document can be filed against a quote that is still current — not one a revision replaced.
  const fileAgainst = (quoteGroups ?? []).filter((group) => !group.superseded).map((group) => ({ id: group.id, label: `Q-${group.number} (${group.status})` }));
  const moneyFmt = await getRegionalSettings();
  // The workspace's suppliers (Settings → Suppliers): the upload's and Label's supplier choice.
  const tenantId = await actingTenantId();
  // Null while the Suppliers module is off: no supplier choice on upload or Label, none shown on a row.
  const vendors = (await isModuleEnabled("suppliers"))
    ? await prisma.vendor.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : null;
  // A current quote with a supplier quote filed on it offers to take that supplier's prices as its costs.
  // Only for someone who may edit quotes — cost and margin are theirs, and the save needs it.
  const costQuoteIds = vendors === null || !(quoteGroups ?? []).length || !(await hasPermission(await requireUser(), "quotes.edit"))
    ? []
    : (quoteGroups ?? []).filter((group) => !group.superseded && group.documents.some((doc) => isSupplierQuote(doc.tag))).map((group) => group.id);
  const costQuotes = costQuoteIds.length
    ? await prisma.quote.findMany({
        where: { tenantId, id: { in: costQuoteIds }, deletedAt: null },
        select: {
          id: true,
          taxInclusive: true,
          items: {
            orderBy: { sortOrder: "asc" },
            select: { id: true, description: true, qty: true, unitPriceCents: true, discountPct: true, taxRatePct: true, costCents: true, optional: true, selected: true },
          },
        },
      })
    : [];
  // What each supplier invoice on this list says (read by AI, confirmed by a person) — Suppliers module only.
  const invoiceDocIds = vendors === null
    ? []
    : [...documents, ...(quoteGroups ?? []).flatMap((group) => group.documents)].filter((doc) => isSupplierInvoice(doc.tag)).map((doc) => doc.id);
  const invoiceRows = invoiceDocIds.length
    ? await prisma.supplierInvoice.findMany({
        where: { tenantId, documentId: { in: invoiceDocIds } },
        select: { documentId: true, invoiceNumber: true, invoiceDate: true, dueDate: true, totalCents: true, currency: true, status: true },
      })
    : [];
  const invoices: InvoiceMap = new Map(invoiceDocIds.map((id) => [id, invoiceRows.find((row) => row.documentId === id) ?? null]));
  const invoiceMoney = (cents: number, currency: string | null) => formatZAR(cents, withCurrency(moneyFmt, currency));
  return (
    <div className="card">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        <FileText className="size-4 text-primary" />
      </div>

      {!hideUpload && (
        <SaveForm
          action={uploadDocument}
          className="mb-4 grid gap-2 rounded-xl border border-border bg-muted/20 p-3"
        >
          {/* What it is, and which quote it belongs to. It also carries the customer as the
              target — or the quote instead, when one is chosen: an upload names ONE record. */}
          <DocumentUploadFields types={types} quotes={fileAgainst} contactId={contactId} vendors={vendors ?? undefined} defaultQuoteId={defaultQuoteId} />
          {vehicleId && <input type="hidden" name="vehicleId" value={vehicleId} />}
          {jobCardId && <input type="hidden" name="jobCardId" value={jobCardId} />}
          <input type="hidden" name="revalidate" value={revalidate} />
          <input
            type="file"
            name="file"
            required
            className="w-full min-w-0 text-xs text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-background file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-foreground"
          />
          <SaveButton className="btn-primary btn-sm w-full" pendingLabel="Uploading…"><Upload className="size-4" />Upload document</SaveButton>
        </SaveForm>
      )}

      {/* A quote is listed whether or not it has any paperwork yet — an accepted,
          signed quote that nobody generated a PDF for used to vanish from here
          entirely. The heading opens the quote itself; once signed that is the
          locked, signed copy. */}
      {grouped && (
        <div className="mb-4 space-y-3">
          {quoteGroups.map((group) => (
            <div key={group.id} className="rounded-xl border border-border bg-muted/10 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/quotes/${group.id}`}
                  className="text-sm font-semibold text-orange-400 hover:underline"
                >
                  Q-{group.number}
                </Link>
                <StatusPill tone={statusTone(group.status)}>{group.status}</StatusPill>
                {group.signed && <StatusPill tone="success">Signed</StatusPill>}
                {group.superseded && <StatusPill tone="neutral">Superseded</StatusPill>}
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {formatZAR(Math.round(group.totalCents), withCurrency(moneyFmt, group.currency))} · {formatDate(group.createdAt)}
                </span>
                {quoteActions && !group.superseded && (
                  <QuoteRowActions
                    quoteId={group.id}
                    number={group.number}
                    status={group.status}
                    signed={group.signed}
                    canCancel={quoteActions.canCancel}
                    canDuplicate={quoteActions.canDuplicate}
                  />
                )}
              </div>
              {group.documents.length === 0 && !group.handoverPhotos?.length ? (
                <p className="mt-2 text-xs text-slate-500">
                  No paperwork filed against this quote yet.
                </p>
              ) : (() => {
                // Customer, then each supplier by name — headings only once a supplier paper is on the quote.
                const sections = partiesOf([...group.documents].sort(byLifecycle).map((doc) => (vendors === null ? { ...doc, vendor: undefined } : doc)));
                const headed = sections.some((section) => section.supplier);
                return sections.map((section) => (
                  <div key={section.key} className={headed ? "mt-2" : ""}>
                    {headed && (
                      <p className={`text-[10px] font-semibold uppercase tracking-widest ${section.supplier ? "text-sky-300/80" : "text-emerald-300/80"}`}>
                        {section.label} <span className="font-normal text-muted-foreground">· {section.docs.length}</span>
                      </p>
                    )}
                    <ul className="mt-1 divide-y divide-slate-800">
                      {section.docs.map((doc) => (
                        <DocRow key={doc.id} doc={doc} revalidate={revalidate} types={types} vendors={vendors} invoices={invoices} money={invoiceMoney} />
                      ))}
                    </ul>
                  </div>
                ));
              })()}
              {group.handoverPhotos && group.handoverPhotos.length > 0 && (
                <div className="mt-3" data-search="handover photos delivery checklist">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-300/80">
                    Handover photos <span className="font-normal text-muted-foreground">· {group.handoverPhotos.length} · from the delivery checklist</span>
                  </p>
                  <div className="mt-1.5 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                    {group.handoverPhotos.map((photo) => (
                      <a
                        key={photo.id}
                        href={photo.src ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        title={`${photo.step} · ${formatDate(photo.takenAt)}`}
                        className="group block overflow-hidden rounded-lg border border-border bg-muted/20"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- a stored, workspace-checked file, not a static asset */}
                        <img src={photo.src ?? undefined} alt={photo.step} loading="lazy" className="aspect-square w-full object-cover transition-transform group-hover:scale-105" />
                        <p className="truncate px-1.5 py-1 text-[10px] text-muted-foreground">{photo.step}</p>
                      </a>
                    ))}
                  </div>
                </div>
              )}
              {(() => {
                const quote = costQuotes.find((q) => q.id === group.id);
                return quote && quote.items.length > 0 ? (
                  <QuoteCostsBox quoteId={group.id} items={quote.items} taxInclusive={quote.taxInclusive} revalidate={revalidate} money={(cents) => formatZAR(cents, withCurrency(moneyFmt, group.currency))} />
                ) : null;
              })()}
            </div>
          ))}
        </div>
      )}

      {documents.length === 0 ? (
        !grouped && <p className="text-sm text-slate-400">{emptyText}</p>
      ) : (
        <>
          {grouped && (
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Other documents
            </p>
          )}
          <ul className="divide-y divide-slate-800">
            {documents.map((doc) => (
              <DocRow key={doc.id} doc={doc} revalidate={revalidate} types={types} vendors={vendors} invoices={invoices} money={invoiceMoney} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
