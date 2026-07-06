import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import ModalTrigger from "@/components/Modal";
import ConfirmDelete from "@/components/ConfirmDelete";
import {
  createLibraryDocument,
  addLibraryVersion,
  deleteLibraryDocument,
} from "@/app/actions/library";
import { formatDateTime } from "@/lib/format";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const CATEGORIES = ["Brochure", "Price list", "Spec sheet", "Warranty", "Other"];

export default async function LibraryPage() {
  await requireUser();
  const documents = await prisma.libraryDocument.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      versions: { orderBy: { version: "desc" }, include: { uploadedBy: true } },
    },
  });

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Document library</h1>
          <p className="text-sm text-slate-400 mt-1">
            Brochures, price lists and spec sheets — versioned, so everyone always uses the
            latest. Attach them to emails straight from any lead or contact.
          </p>
        </div>
        <ModalTrigger label="+ Add document" title="Add document to library">
          <form action={createLibraryDocument} className="card space-y-4">
            <div>
              <label className="label">Document name *</label>
              <input name="name" className="input" required placeholder="e.g. Denago EV Price List" />
            </div>
            <div>
              <label className="label">Category</label>
              <select name="category" className="input" defaultValue="Brochure">
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">File *</label>
              <input type="file" name="file" required className="text-sm w-full file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-slate-700 file:bg-slate-800 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-slate-300" />
            </div>
            <button className="btn-primary">Add to library</button>
          </form>
        </ModalTrigger>
      </div>

      {documents.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-slate-400">No documents yet — add your first brochure or price list.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {documents.map((doc) => {
            const latest = doc.versions[0];
            return (
              <div key={doc.id} className="card">
                <div className="flex items-center gap-4 flex-wrap">
                  <span className="text-2xl">📄</span>
                  <div className="flex-1 min-w-48">
                    <p className="font-semibold">
                      {doc.name}{" "}
                      <span className="badge bg-orange-500/15 text-orange-300 ml-1">
                        v{latest?.version ?? 0} — latest
                      </span>
                    </p>
                    <p className="text-xs text-slate-400">
                      {doc.category ?? "Document"} · {latest ? humanSize(latest.sizeBytes) : ""} ·
                      updated {formatDateTime(doc.updatedAt)}
                      {latest ? ` by ${latest.uploadedBy.name}` : ""}
                    </p>
                  </div>
                  {latest && (
                    <a href={`/api/library/${latest.id}`} className="btn-primary btn-sm">
                      ⬇ Download latest
                    </a>
                  )}
                  <ModalTrigger
                    label="⬆ New version"
                    title={`New version of ${doc.name}`}
                    buttonClass="btn-secondary btn-sm"
                  >
                    <form action={addLibraryVersion.bind(null, doc.id)} className="card space-y-4">
                      <div>
                        <label className="label">File * (will become v{(latest?.version ?? 0) + 1})</label>
                        <input type="file" name="file" required className="text-sm w-full file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-slate-700 file:bg-slate-800 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-slate-300" />
                      </div>
                      <div>
                        <label className="label">What changed?</label>
                        <input name="note" className="input" placeholder="e.g. Updated 2026 pricing" />
                      </div>
                      <button className="btn-primary">Upload new version</button>
                    </form>
                  </ModalTrigger>
                  <ConfirmDelete
                    action={deleteLibraryDocument.bind(null, doc.id)}
                    title={`Delete “${doc.name}”?`}
                    description="The document and all its versions move to the Trash for 60 days."
                    trigger="✕"
                    triggerClass="text-xs text-slate-600 hover:text-red-500 cursor-pointer"
                  />
                </div>

                {doc.versions.length > 1 && (
                  <details className="mt-3">
                    <summary className="text-xs font-medium text-orange-400 cursor-pointer hover:underline">
                      Version history ({doc.versions.length})
                    </summary>
                    <ul className="mt-2 divide-y divide-slate-800">
                      {doc.versions.map((v) => (
                        <li key={v.id} className="py-2 flex items-center gap-3 text-sm">
                          <span
                            className={`badge ${
                              v.id === latest?.id
                                ? "bg-orange-500/15 text-orange-300"
                                : "bg-slate-800 text-slate-400"
                            }`}
                          >
                            v{v.version}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="truncate">{v.fileName}</p>
                            <p className="text-xs text-slate-500">
                              {humanSize(v.sizeBytes)} · {formatDateTime(v.createdAt)} ·{" "}
                              {v.uploadedBy.name}
                              {v.note ? ` — ${v.note}` : ""}
                            </p>
                          </div>
                          <a href={`/api/library/${v.id}`} className="btn-secondary btn-sm">
                            ⬇
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
