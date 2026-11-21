import { Download, Upload } from "lucide-react";
import ModalTrigger from "@/components/Modal";
import ConfirmDelete from "@/components/ConfirmDelete";
import { deleteLibraryDocument } from "@/app/actions/library";
import { NewVersionForm } from "@/components/LibraryUploader";
import { formatDateTime } from "@/lib/format";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { setLibraryCategory } from "@/app/actions/libraryCategories";

type Version = {
  id: string;
  version: number;
  fileName: string;
  sizeBytes: number;
  createdAt: Date;
  note: string | null;
  uploadedBy: { name: string };
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * A Library document's own actions, shown in the Documents preview panel:
 * version history, a new version, and delete.
 *
 * Moved here from the old /library page when the Library was merged into
 * Documents, unchanged in behaviour. Every action re-checks library.manage on
 * the server; `canManage` only decides whether the controls are offered.
 */
export default function LibraryItemActions({
  documentId,
  name,
  versions,
  canManage,
  category = null,
  categories = [],
}: {
  documentId: string;
  name: string;
  /** Newest first. */
  versions: Version[];
  canManage: boolean;
  /** Its category now, and the workspace's list to change it to (lib/libraryCategories.ts). */
  category?: string | null;
  categories?: readonly string[];
}) {
  const latest = versions[0];
  // A category that has since left the list stays selectable as itself, so saving doesn't drop it.
  const options = category && !categories.includes(category) ? [category, ...categories] : categories;
  return (
    <div className="space-y-3 border-t border-border pt-3">
      {canManage && options.length > 0 && (
        <SaveForm action={setLibraryCategory.bind(null, documentId)} success="Category saved" resetOnSuccess={false} className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor={`category-${documentId}`}>Category</label>
          <select id={`category-${documentId}`} name="category" defaultValue={category ?? ""} className="input !w-auto !py-1">
            <option value="">No category</option>
            {options.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
        </SaveForm>
      )}
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <ModalTrigger
            label={<><Upload className="size-3.5" />New version</>}
            title={`New version of ${name}`}
            buttonClass="btn-secondary btn-sm"
          >
            <NewVersionForm documentId={documentId} nextVersion={(latest?.version ?? 0) + 1} />
          </ModalTrigger>
          <ConfirmDelete
            action={deleteLibraryDocument.bind(null, documentId)}
            title={`Delete “${name}”?`}
            description="The document and all its versions move to the Trash for 60 days."
            // A button beside New version, not faint text (Sean, 2026-11-21: "So nothing can be deleted from the library?").
            trigger="Delete"
            triggerClass="btn-danger btn-sm"
          />
        </div>
      )}

      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Versions ({versions.length})
        </p>
        <ul className="divide-y divide-border/50 rounded-lg border border-border">
          {versions.map((v) => (
            <li key={v.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <span
                className={`badge ${v.id === latest?.id ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}
              >
                v{v.version}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate">{v.fileName}</p>
                <p className="text-[11px] text-muted-foreground">
                  {humanSize(v.sizeBytes)} · {formatDateTime(v.createdAt)} · {v.uploadedBy.name}
                  {v.note ? ` — ${v.note}` : ""}
                </p>
              </div>
              <a
                href={`/api/library/${v.id}`}
                className="btn-secondary btn-sm"
                aria-label={`Download version ${v.version}`}
              >
                <Download className="size-3.5" />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
