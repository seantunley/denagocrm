"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { registerUploadedDocument, uploadDocument } from "@/app/actions/documents";
import { photoUploadAccess } from "@/lib/photoTransport";
import type { UploadTarget } from "@/lib/documentFolders";
import { MAX_DOCUMENT_BYTES, documentUploadPrefix } from "@/lib/documentUpload";

export type UploadState = { name: string; status: "waiting" | "uploading" | "done" | "failed"; message?: string };

/**
 * The fallback path's ceiling. A Server Action on Vercel cannot receive a body
 * over 4.5 MB, so this applies only where there is no Blob store to upload to
 * directly — in practice, a local checkout without a Blob token.
 */
const FORM_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

export function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A filename safe to put in a storage path. The display name is kept separately. */
const pathSafe = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "file";

/**
 * Upload files into a folder: straight to storage, then registered.
 *
 * DIRECT BY DEFAULT. Each file goes browser → Blob storage under a path the
 * server signed for this target (/api/documents/upload), and is then recorded by
 * registerUploadedDocument, which re-checks everything. Nothing passes through a
 * function body, so the 4.5 MB ceiling that used to reject any larger document
 * does not apply; the limit is MAX_DOCUMENT_BYTES.
 *
 * The Server Action path remains only as the fallback for a deployment with no
 * Blob store, where there is nowhere to upload directly.
 */
export function useDocumentUploads(target: UploadTarget | null, tenantId: string | null) {
  const router = useRouter();
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [, startRefresh] = useTransition();

  async function uploadFiles(files: File[]) {
    if (!target || files.length === 0) return;
    setUploads(files.map((file) => ({ name: file.name, status: "waiting" })));

    // Asked once for the batch: whether this deployment uploads directly, and to
    // which store. A failure means "no direct path", not "stop".
    const access = await photoUploadAccess().catch(() => null);

    // One at a time, so a folder of files does not open a dozen uploads at once
    // on a site's shared connection.
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const set = (patch: Partial<UploadState>) =>
        setUploads((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));

      if (file.size === 0) {
        set({ status: "failed", message: "the file is empty" });
        continue;
      }
      if (file.size > MAX_DOCUMENT_BYTES) {
        set({ status: "failed", message: `${formatSize(file.size)} — over the ${formatSize(MAX_DOCUMENT_BYTES)} limit` });
        continue;
      }
      set({ status: "uploading" });

      try {
        if (access && tenantId) {
          const blob = await upload(
            `${documentUploadPrefix(tenantId, target)}${crypto.randomUUID()}-${pathSafe(file.name)}`,
            file,
            {
              access,
              handleUploadUrl: "/api/documents/upload",
              clientPayload: JSON.stringify(target),
            },
          );
          const result = await registerUploadedDocument({ target, url: blob.url, fileName: file.name });
          if (result?.error) set({ status: "failed", message: result.error });
          else set({ status: "done" });
        } else {
          if (file.size > FORM_UPLOAD_MAX_BYTES) {
            set({ status: "failed", message: `${formatSize(file.size)} — this server has no file storage for files over 4 MB` });
            continue;
          }
          const form = new FormData();
          form.set("file", file);
          form.set("revalidate", "/documents");
          if (target.kind === "record") form.set(target.field, target.id);
          await uploadDocument(form);
          set({ status: "done" });
        }
      } catch {
        // The token route refuses with a generic message and Server Action
        // errors are redacted in production; the System Log has the cause.
        set({ status: "failed", message: "upload failed — you may not have access to file here" });
      }
    }
    startRefresh(() => router.refresh());
  }

  return { uploads, uploadFiles };
}
