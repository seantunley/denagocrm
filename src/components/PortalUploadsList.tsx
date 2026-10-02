import Link from "next/link";
import { Upload } from "lucide-react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { StatusPill } from "@/components/visual-system";
import { markPortalUploadReviewed } from "@/app/actions/portalUploads";
import { formatDateTime } from "@/lib/format";

export type PortalUploadRow = {
  id: string;
  fileName: string;
  sizeBytes: number;
  createdAt: Date;
  status: string;
  caseId: string | null;
  caseLabel: string | null;
  /** Shown in the cross-customer queue; omitted on the customer's own page. */
  contact?: { id: string; name: string };
};

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Files customers sent through the portal (gap audit #30). Ones attached to a
 * case also show on the case; the rest had no staff screen at all.
 */
export default function PortalUploadsList({ uploads, canReview, empty }: { uploads: PortalUploadRow[]; canReview: boolean; empty?: string }) {
  if (uploads.length === 0) {
    return empty ? <p className="text-sm text-muted-foreground">{empty}</p> : null;
  }
  return (
    <ul className="divide-y divide-border">
      {uploads.map((upload) => (
        <li key={upload.id} className="flex flex-wrap items-center gap-3 py-2.5">
          <Upload className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            {/* The staff download route authorises the case, or the contact for a case-less file. */}
            <a href={`/api/cases/uploads/${upload.id}`} className="block truncate text-sm font-medium text-primary hover:underline">
              {upload.fileName}
            </a>
            <p className="text-xs text-muted-foreground">
              {upload.contact && (
                <>
                  <Link href={`/contacts/${upload.contact.id}`} className="hover:underline">{upload.contact.name}</Link>
                  {" · "}
                </>
              )}
              {formatDateTime(upload.createdAt)} · {size(upload.sizeBytes)}
              {upload.caseId && (
                <>
                  {" · "}
                  <Link href={`/cases/${upload.caseId}`} className="hover:underline">{upload.caseLabel ?? "Support case"}</Link>
                </>
              )}
            </p>
          </div>
          {upload.status === "reviewed" ? (
            <StatusPill tone="neutral">Reviewed</StatusPill>
          ) : (
            <>
              <StatusPill tone="info">New</StatusPill>
              {canReview && (
                <SaveForm action={markPortalUploadReviewed.bind(null, upload.id)}>
                  <SaveButton className="btn-secondary btn-sm" pendingLabel="Saving…">Mark reviewed</SaveButton>
                </SaveForm>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
