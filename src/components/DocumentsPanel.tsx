import { uploadDocument, deleteDocument } from "@/app/actions/documents";
import ConfirmDelete from "@/components/ConfirmDelete";
import { formatDate } from "@/lib/format";

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
  uploadedBy: { name: string };
};

export default function DocumentsPanel({
  documents,
  contactId,
  vehicleId,
  jobCardId,
  revalidate,
}: {
  documents: Doc[];
  contactId?: string;
  vehicleId?: string;
  jobCardId?: string;
  revalidate: string;
}) {
  return (
    <div className="card">
      <h2 className="font-semibold mb-4">Documents</h2>

      <form
        action={uploadDocument}
        className="flex items-center gap-3 mb-4 rounded-lg bg-slate-800/40 p-3 border border-slate-800"
      >
        {contactId && <input type="hidden" name="contactId" value={contactId} />}
        {vehicleId && <input type="hidden" name="vehicleId" value={vehicleId} />}
        {jobCardId && <input type="hidden" name="jobCardId" value={jobCardId} />}
        <input type="hidden" name="revalidate" value={revalidate} />
        <input
          type="file"
          name="file"
          required
          className="text-sm flex-1 file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-slate-700 file:bg-slate-900 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-slate-300"
        />
        <button className="btn-primary btn-sm">Upload</button>
      </form>

      {documents.length === 0 ? (
        <p className="text-sm text-slate-400">No documents uploaded.</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2 group">
              <span>📄</span>
              <div className="flex-1 min-w-0">
                <a
                  href={`/api/files/${d.id}`}
                  className="text-sm font-medium text-orange-400 hover:underline truncate block"
                  target="_blank"
                >
                  {d.fileName}
                </a>
                <p className="text-xs text-slate-400">
                  {humanSize(d.sizeBytes)} · {formatDate(d.createdAt)} · {d.uploadedBy.name}
                </p>
              </div>
              <div className="opacity-0 group-hover:opacity-100">
                <ConfirmDelete
                  action={deleteDocument.bind(null, d.id, revalidate)}
                  title={`Delete document “${d.fileName}”?`}
                  description="The document moves to the Trash and can be restored for 60 days."
                  trigger="✕"
                  triggerClass="text-xs text-slate-600 hover:text-red-500 cursor-pointer"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
