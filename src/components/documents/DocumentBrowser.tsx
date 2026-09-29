"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
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
import { ManageDocumentDialog, type MoveTargets } from "@/components/RepoRow";
import { formatSize, useDocumentUploads, type UploadState } from "@/components/documents/useDocumentUploads";
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
  /**
   * A Library item, not a record Document. It is served by its own
   * permission-checked route and managed by its own actions (new version,
   * delete), passed in as `actions` because the Library keeps versions and
   * record documents do not.
   */
  library?: { versionId: string; actions: ReactNode };
};

/**
 * Where a file is read from — always a permission-checked route, never a
 * storage URL. Record documents: /api/files; Library items: /api/library, by
 * the latest version's id.
 */
const fileHref = (doc: BrowserDoc) => (doc.library ? `/api/library/${doc.library.versionId}` : `/api/files/${doc.id}`);

/** Only these are served inline by /api/files — everything else downloads. */
const isImage = (doc: BrowserDoc) => /^image\/(png|jpe?g|gif|webp|avif)$/i.test(doc.mimeType);
const isPdf = (doc: BrowserDoc) => /^application\/pdf$/i.test(doc.mimeType);

function DocIcon({ doc, className }: { doc: BrowserDoc; className?: string }) {
  const Icon = isImage(doc) ? ImageIcon : isPdf(doc) ? FileText : FileIcon;
  return <Icon className={className} />;
}

function UploadProgress({ uploads }: { uploads: UploadState[] }) {
  if (uploads.length === 0) return null;
  return (
    <ul className="mb-3 space-y-1 rounded-xl border border-border bg-card p-3 text-[12px]">
      {uploads.map((item, index) => (
        <li key={`${item.name}-${index}`} className="flex items-center gap-2">
          {item.status === "uploading" && <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />}
          {item.status === "waiting" && <Loader2 className="size-3.5 shrink-0 text-muted-foreground" />}
          {item.status === "done" && <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />}
          {item.status === "failed" && <XCircle className="size-3.5 shrink-0 text-destructive" />}
          <span className="truncate">{item.name}</span>
          {item.message && <span className="shrink-0 text-muted-foreground">· {item.message}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Upload into a folder without the browser around it — the phone's quick capture.
 * Same path as the desktop drop zone: straight to storage, then registered.
 */
export function DocumentUploader({
  target,
  tenantId,
  hint,
}: {
  target: UploadTarget;
  tenantId: string | null;
  hint: string;
}) {
  const { uploads, uploadFiles } = useDocumentUploads(target, tenantId);
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div className="rounded-2xl border border-primary/20 bg-primary/[0.06] p-3">
      <p className="mb-2 text-xs font-semibold text-foreground">{hint}</p>
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
      <Button size="sm" className="w-full" onClick={() => picker.current?.click()}>
        <Upload className="size-4" />
        Choose files
      </Button>
      {uploads.length > 0 && <div className="mt-2"><UploadProgress uploads={uploads} /></div>}
    </div>
  );
}

export default function DocumentBrowser({
  docs,
  view,
  uploadTarget,
  uploadTenantId,
  uploadHint,
  canUpload,
  canManage,
  targets,
}: {
  docs: BrowserDoc[];
  view: "grid" | "list";
  /** Where a file dropped here is filed; null where this folder cannot take uploads. */
  uploadTarget: UploadTarget | null;
  /** The workspace the upload path is written under; the server checks it. */
  uploadTenantId: string | null;
  uploadHint: string;
  canUpload: boolean;
  canManage: boolean;
  targets: MoveTargets;
}) {
  const router = useRouter();
  const [previewing, setPreviewing] = useState<BrowserDoc | null>(null);
  const [managing, setManaging] = useState<BrowserDoc | null>(null);
  const [dragging, setDragging] = useState(false);
  const [, startRefresh] = useTransition();
  const picker = useRef<HTMLInputElement>(null);

  const acceptsUploads = canUpload && uploadTarget !== null;
  const { uploads, uploadFiles } = useDocumentUploads(acceptsUploads ? uploadTarget : null, uploadTenantId);

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

      <UploadProgress uploads={uploads} />

      {docs.length === 0 ? (
        <p className="rounded-xl border border-border bg-card/50 py-12 text-center text-sm text-muted-foreground">
          {acceptsUploads ? "No files here yet — drop some in." : "No files in this folder."}
        </p>
      ) : view === "grid" ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {docs.map((doc) => (
            <RecordContextMenu key={doc.id} label={doc.fileName} href={fileHref(doc)} openInNewTab>
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
                        src={fileHref(doc)}
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
            <RecordContextMenu key={doc.id} label={doc.fileName} href={fileHref(doc)} openInNewTab>
              <li>
                <button
                  type="button"
                  onClick={() => setPreviewing(doc)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
                    {isImage(doc) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={fileHref(doc)} alt="" loading="lazy" className="size-full object-cover" />
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
                      {doc.filedOn ?? "Unfiled"} · {formatSize(doc.sizeBytes)} · {doc.createdAt} · {doc.uploadedBy}
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
                  {previewing.filedOn ?? "Unfiled"}
                  {previewing.superseded ? " · old version" : ""}
                </SheetDescription>
              </SheetHeader>

              <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
                {isImage(previewing) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={fileHref(previewing)}
                    alt={previewing.fileName}
                    className="mx-auto max-h-[70vh] rounded-lg object-contain"
                  />
                ) : isPdf(previewing) ? (
                  <iframe
                    src={fileHref(previewing)}
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
                    href={fileHref(previewing)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    <ExternalLink className="size-4" />
                    Open in new tab
                  </a>
                  <a
                    href={fileHref(previewing)}
                    download={previewing.fileName}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    <Download className="size-4" />
                    Download
                  </a>
                  {canManage && !previewing.superseded && !previewing.library && (
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
                {/* A Library item's own actions: version history, new version,
                    delete — rendered by the server with its permissions applied. */}
                {previewing.library?.actions}
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
