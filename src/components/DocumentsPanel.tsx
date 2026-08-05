import Link from "next/link";
import { uploadDocument, deleteDocument } from "@/app/actions/documents";
import ConfirmDelete from "@/components/ConfirmDelete";
import { StatusPill } from "@/components/visual-system";
import { formatDate, formatZAR } from "@/lib/format";
import { FileText, Upload } from "lucide-react";

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
};

/** A quote and every piece of paper that belongs to it. */
export type QuoteGroup = {
  id: string;
  number: number;
  status: string;
  signed: boolean;
  superseded: boolean;
  totalCents: number;
  createdAt: Date;
  documents: Doc[];
};

/**
 * What each tag means to someone reading the tab. Untagged files keep their
 * filename only — a label of "other" tells the reader nothing.
 */
const TAG_LABELS: Record<string, string> = {
  signed: "Signed copy",
  invoice: "Invoice",
  pop: "Proof of payment",
  "delivery-note": "Delivery note",
  "delivery-photo": "Delivery photo",
  "delivery-signature": "Handover signature",
  checkin: "Check-in",
};

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

function DocRow({ doc, revalidate }: { doc: Doc; revalidate: string }) {
  const label = doc.tag ? TAG_LABELS[doc.tag] : null;
  return (
    <li className="group flex items-center gap-3 py-2">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/30 text-muted-foreground">
        <FileText className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <a
          href={`/api/files/${doc.id}`}
          className="block truncate text-sm font-medium text-orange-400 hover:underline"
          target="_blank"
        >
          {doc.fileName}
        </a>
        <p className="text-xs text-slate-400">
          {label ? `${label} · ` : ""}
          {humanSize(doc.sizeBytes)} · {formatDate(doc.createdAt)} · {doc.uploadedBy.name}
          {doc.ownerLabel ? ` · ${doc.ownerLabel}` : ""}
        </p>
      </div>
      <div className="opacity-0 group-hover:opacity-100">
        <ConfirmDelete
          action={deleteDocument.bind(null, doc.id, revalidate)}
          title={`Delete document “${doc.fileName}”?`}
          description="The document moves to the Trash and can be restored for 60 days."
          trigger="✕"
          triggerClass="cursor-pointer text-xs text-slate-600 hover:text-red-500"
        />
      </div>
    </li>
  );
}

export default function DocumentsPanel({
  documents,
  quoteGroups,
  contactId,
  vehicleId,
  jobCardId,
  revalidate,
  hideUpload = false,
  emptyText = "No documents uploaded.",
}: {
  documents: Doc[];
  /** Quote-by-quote grouping. Omit for the vehicle and job card panels. */
  quoteGroups?: QuoteGroup[];
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
  return (
    <div className="card">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-semibold">Documents</h2>
        <FileText className="size-4 text-primary" />
      </div>

      {!hideUpload && (
        <form
          action={uploadDocument}
          className="mb-4 grid gap-2 rounded-xl border border-border bg-muted/20 p-3"
        >
          {contactId && <input type="hidden" name="contactId" value={contactId} />}
          {vehicleId && <input type="hidden" name="vehicleId" value={vehicleId} />}
          {jobCardId && <input type="hidden" name="jobCardId" value={jobCardId} />}
          <input type="hidden" name="revalidate" value={revalidate} />
          <input
            type="file"
            name="file"
            required
            className="w-full min-w-0 text-xs text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-background file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-foreground"
          />
          <button className="btn-primary btn-sm w-full"><Upload className="size-4" />Upload document</button>
        </form>
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
                  {formatZAR(Math.round(group.totalCents))} · {formatDate(group.createdAt)}
                </span>
              </div>
              {group.documents.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                  No paperwork filed against this quote yet.
                </p>
              ) : (
                <ul className="mt-1 divide-y divide-slate-800">
                  {[...group.documents].sort(byLifecycle).map((doc) => (
                    <DocRow key={doc.id} doc={doc} revalidate={revalidate} />
                  ))}
                </ul>
              )}
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
              <DocRow key={doc.id} doc={doc} revalidate={revalidate} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
