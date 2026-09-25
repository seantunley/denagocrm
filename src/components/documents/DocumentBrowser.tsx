"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  File as FileIcon,
  FileText,
  History,
  Image as ImageIcon,
  Loader2,
  Settings2,
  Upload,
  XCircle,
} from "lucide-react";
import { uploadDocument } from "@/app/actions/documents";
import { ManageDocumentDialog, type MoveTargets } from "@/components/RepoRow";
import RecordContextMenu from "@/components/RecordContextMenu";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { UploadTarget } from "@/lib/documentFolders";
import { cn } from "@/lib/utils";

export type BrowserDoc = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  tag: string | null;
  createdAt: string;
  uploadedBy: string;
  filedOn: string | null;
  superseded: boolean;
};

/**
 * Uploads go through a Server Action, and Vercel refuses any function request
 * body over 4.5 MB before the action runs — whatever the app's own limit says.
 * Checked here so a bigger file gets a plain explanation instead of a generic
 * failure. Large files need a direct-to-storage upload, as photos have; that is
 * a separate change.
 */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Only these are served inline by /api/files — everything else downloads. */
const isImage = (doc: BrowserDoc) => /^image\/(png|jpe?g|gif|webp|avif)$/i.test(doc.mimeType);
const isPdf = (doc: BrowserDoc) => /^application\/pdf$/i.test(doc.mimeType);

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocIcon({ doc, className }: { doc: BrowserDoc; className?: string }) {
  const Icon = isImage(doc) ? ImageIcon : isPdf(doc) ? FileText : FileIcon;
  return <Icon className={className} />;
}

type UploadState = { name: string; status: "waiting" | "uploading" | "done" | "failed"; message?: string };

export default function DocumentBrowser({
  docs,
  view,
  uploadTarget,
  uploadHint,
  canUpload,
  canManage,
  targets,
}: {
  docs: BrowserDoc[];
  view: "grid" | "list";
  /** Where a file dropped here is filed; null where this folder cannot take uploads. */
  uploadTarget: UploadTarget | null;
  uploadHint: string;
  canUpload: boolean;
  canManage: boolean;
  targets: MoveTargets;
}) {
  const router = useRouter();
  const [previewing, setPreviewing] = useState<BrowserDoc | null>(null);
  const [managing, setManaging] = useState<BrowserDoc | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragging, setDragging] = useState(false);
  const [, startRefresh] = useTransition();
  const picker = useRef<HTMLInputElement>(null);

  const acceptsUploads = canUpload && uploadTarget !== null;

  async function uploadFiles(files: File[]) {
    if (!acceptsUploads || !uploadTarget || files.length === 0) return;
    setUploads(files.map((file) => ({ name: file.name, status: "waiting" })));

    // One at a time: each is its own authorised Server Action call, and a folder
    // of photos in parallel would stack up requests against the same limit.
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const set = (patch: Partial<UploadState>) =>
        setUploads((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));

      if (file.size > MAX_UPLOAD_BYTES) {
        set({ status: "failed", message: `${formatSize(file.size)} — files over 4 MB can't be uploaded here yet` });
        continue;
      }
      set({ status: "uploading" });
      const form = new FormData();
      form.set("file", file);
      form.set("revalidate", "/documents");
      if (uploadTarget.kind === "record") form.set(uploadTarget.field, uploadTarget.id);
      try {
        await uploadDocument(form);
        set({ status: "done" });
      } catch {
        // Server Action errors are redacted in production, so the cause is not
        // available here; the audit trail and System Log have it.
        set({ status: "failed", message: "upload failed — you may not have access to file here" });
      }
    }
    startRefresh(() => router.refresh());
  }

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void uploadFiles([...event.dataTransfer.files]);
  };

  return (
    <div
      className={cn("relative rounded-xl", dragging && "ring-2 ring-primary ring-offset-2 ring-offset-background")}
      onDragOver={(event) => {
        if (!acceptsUploads) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={acceptsUploads ? onDrop : undefined}
    >
      {canUpload && (
        <div
          className={cn(
            "mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-sm",
            acceptsUploads ? "border-primary/40 bg-primary/[0.04]" : "border-border text-muted-foreground",
          )}
        >
          <Upload className={cn("size-4 shrink-0", acceptsUploads ? "text-primary" : "text-muted-foreground")} />
          <p className="min-w-0 flex-1 text-[13px]">{uploadHint}</p>
          {acceptsUploads && (
            <>
              <input
                ref={picker}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  void uploadFiles([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
              <Button size="sm" onClick={() => picker.current?.click()}>
                <Upload className="size-4" />
                Choose files
              </Button>
            </>
          )}
        </div>
      )}

      {uploads.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-xl border border-border bg-card p-3 text-[12px]">
          {uploads.map((item, index) => (
            <li key={`${item.name}-${index}`} className="flex items-center gap-2">
              {item.status === "uploading" && <Loader2 className="size-3.5 animate-spin text-primary" />}
              {item.status === "waiting" && <Loader2 className="size-3.5 text-muted-foreground" />}
              {item.status === "done" && <CheckCircle2 className="size-3.5 text-emerald-400" />}
              {item.status === "failed" && <XCircle className="size-3.5 text-destructive" />}
              <span className="truncate">{item.name}</span>
              {item.message && <span className="shrink-0 text-muted-foreground">· {item.message}</span>}
            </li>
          ))}
        </ul>
      )}

      {docs.length === 0 ? (
        <p className="rounded-xl border border-border bg-card/50 py-12 text-center text-sm text-muted-foreground">
          {acceptsUploads ? "No files here yet — drop some in." : "No files in this folder."}
        </p>
      ) : view === "grid" ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {docs.map((doc) => (
            <RecordContextMenu key={doc.id} label={doc.fileName} href={`/api/files/${doc.id}`} openInNewTab>
              <li>
                <button
                  type="button"
                  onClick={() => setPreviewing(doc)}
                  className="group flex w-full flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/60">
                    {isImage(doc) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/files/${doc.id}`}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover transition group-hover:scale-[1.02]"
                      />
                    ) : (
                      <DocIcon doc={doc} className="size-9 text-muted-foreground" />
                    )}
                  </span>
                  <span className="space-y-0.5 p-2.5">
                    <span className="block truncate text-[13px] font-medium text-foreground">{doc.fileName}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {formatSize(doc.sizeBytes)} · {doc.createdAt}
                    </span>
                    {(doc.tag || doc.superseded) && (
                      <span className="flex gap-1 pt-0.5">
                        {doc.tag && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{doc.tag}</span>
                        )}
                        {doc.superseded && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">old version</span>
                        )}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            </RecordContextMenu>
          ))}
        </ul>
      ) : (
        <ul className="divide-y divide-border/50 rounded-xl border border-border bg-card">
          {docs.map((doc) => (
            <RecordContextMenu key={doc.id} label={doc.fileName} href={`/api/files/${doc.id}`} openInNewTab>
              <li>
                <button
                  type="button"
                  onClick={() => setPreviewing(doc)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
                    {isImage(doc) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/files/${doc.id}`} alt="" loading="lazy" className="size-full object-cover" />
                    ) : (
                      <DocIcon doc={doc} className="size-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 truncate text-[13px] font-medium text-foreground">
                      <span className="truncate">{doc.fileName}</span>
                      {doc.tag && (
                        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{doc.tag}</span>
                      )}
                      {doc.superseded && (
                        <span className="flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          <History className="size-3" />
                          old version
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {doc.filedOn ?? "Company file"} · {formatSize(doc.sizeBytes)} · {doc.createdAt} · {doc.uploadedBy}
                    </span>
                  </span>
                </button>
              </li>
            </RecordContextMenu>
          ))}
        </ul>
      )}

      <Sheet open={previewing !== null} onOpenChange={(open) => !open && setPreviewing(null)}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
          {previewing && (
            <>
              <SheetHeader className="border-b border-border">
                <SheetTitle className="truncate pr-8">{previewing.fileName}</SheetTitle>
                <SheetDescription>
                  {previewing.filedOn ?? "Company file"}
                  {previewing.superseded ? " · old version" : ""}
                </SheetDescription>
              </SheetHeader>

              <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
                {isImage(previewing) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/files/${previewing.id}`}
                    alt={previewing.fileName}
                    className="mx-auto max-h-[70vh] rounded-lg object-contain"
                  />
                ) : isPdf(previewing) ? (
                  <iframe
                    src={`/api/files/${previewing.id}`}
                    title={previewing.fileName}
                    className="h-[70vh] w-full rounded-lg border border-border bg-white"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
                    <DocIcon doc={previewing} className="size-10" />
                    No preview for this type of file. Download it to open it.
                  </div>
                )}
              </div>

              <div className="space-y-3 border-t border-border p-4">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                  <dt className="text-muted-foreground">Size</dt>
                  <dd>{formatSize(previewing.sizeBytes)}</dd>
                  <dt className="text-muted-foreground">Added</dt>
                  <dd>{previewing.createdAt} by {previewing.uploadedBy}</dd>
                  <dt className="text-muted-foreground">Type</dt>
                  <dd>{previewing.tag ?? "—"}</dd>
                </dl>
                <div className="flex flex-wrap gap-2">
                  <a
                    href={`/api/files/${previewing.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    <ExternalLink className="size-4" />
                    Open in new tab
                  </a>
                  <a
                    href={`/api/files/${previewing.id}`}
                    download={previewing.fileName}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    <Download className="size-4" />
                    Download
                  </a>
                  {canManage && !previewing.superseded && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setManaging(previewing);
                        setPreviewing(null);
                      }}
                    >
                      <Settings2 className="size-4" />
                      Rename, move or replace
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {managing && (
        <ManageDocumentDialog
          doc={managing}
          targets={targets}
          open
          onOpenChange={(open) => {
            if (!open) {
              setManaging(null);
              startRefresh(() => router.refresh());
            }
          }}
        />
      )}
    </div>
  );
}
