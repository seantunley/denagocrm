"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { useRouter } from "next/navigation";
import { registerDeliveryPhotos, uploadDeliveryPhotos } from "@/app/actions/fulfilment";
import { getPhotoUploadPlan, reportPhotoUploadFailure } from "@/app/actions/photoUploads";
import { registerInspectionPhoto, registerJobCardPhotos, uploadCheckoutPhotos, uploadInspectionPhoto, uploadJobCardPhotos } from "@/app/actions/jobcards";
import {
  DIRECT_PHOTO_BATCH_LIMIT,
  MAX_UPLOAD_TOTAL_BYTES,
  checkUploadPayload,
  MAX_PHOTO_BYTES,
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_EDGE,
  fitWithinMaxEdge,
} from "@/lib/photoBudget";

type Kind = "delivery" | "jobcard" | "jobcard-checkout" | "inspection";

/**
 * A short, human-readable reason from whatever was thrown.
 *
 * Every failure here arrives as an exception, and the browser is the only place
 * that ever sees some of them — a blocked request, a store that rejects the
 * token, a Server Action that redirected instead of returning. Reduced to one
 * line so it can be shown next to the button rather than only written somewhere
 * the person has to go and look.
 */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  // A thrown non-Error still has to say something more useful than "undefined".
  try {
    const text = JSON.stringify(error);
    if (text && text !== "{}" && text !== "null") return text;
  } catch {
    // Circular or otherwise unserialisable — fall through to the generic line.
  }
  return "the browser reported no reason";
}

async function preparePhoto(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const { width, height } = fitWithinMaxEdge(bitmap.width, bitmap.height, PHOTO_MAX_EDGE);
  if (width === bitmap.width && height === bitmap.height) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return file;
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY),
  );
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`, {
    type: "image/jpeg",
    lastModified: file.lastModified,
  });
}

export default function DirectPhotoUploader({
  kind,
  recordId,
  tenantId,
  jobCardId,
  label = "Add photos",
  className = "",
}: {
  kind: Kind;
  recordId: string;
  tenantId: string;
  jobCardId?: string;
  label?: string;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function send() {
    const selected = [...(inputRef.current?.files ?? [])];
    setProblem(null);
    if (selected.length === 0) {
      setProblem("Choose at least one photo.");
      return;
    }
    if (kind === "inspection" && selected.length > 1) {
      setProblem("Choose one photo for an inspection item.");
      return;
    }
    if (selected.length > DIRECT_PHOTO_BATCH_LIMIT) {
      setProblem(`Choose up to ${DIRECT_PHOTO_BATCH_LIMIT} photos at a time.`);
      return;
    }

    setWorking(true);
    const staged: { url: string }[] = [];
    let uploadFailures = 0;
    // The first real reason, kept so an all-failed batch can say WHY rather than
    // pointing at a log that may have nothing in it.
    let firstFailure: string | null = null;
    try {
      // The access mode is safe to expose, but the selected store token remains
      // server-only. Fetched once per batch so every upload uses the same mode —
      // and so a deployment with no Blob store is detected before any file is
      // prepared, rather than after the first upload call has already failed.
      const plan = await getPhotoUploadPlan();

      if (plan.transport === "form") {
        // Self-hosted / no Blob store: post through the original upload action,
        // which writes via saveFile() and works on disk. Photos are still resized
        // first, so the request stays inside the declared body limit.
        setStatus(`Preparing ${selected.length} photo${selected.length === 1 ? "" : "s"}…`);
        const prepared = await Promise.all(selected.map(preparePhoto));
        const usable = prepared.filter((f) => f.type.startsWith("image/") && f.size > 0 && f.size <= MAX_PHOTO_BYTES);
        if (usable.length === 0) {
          setProblem("None of those files could be used — photos must be images under 4 MB.");
          return;
        }
        // ONE REQUEST PER BATCH WOULD EXCEED THE BODY LIMIT. This path posts real
        // files through a Server Action, and twelve photos at up to 4 MB is far
        // past the declared limit — the framework rejects the request before the
        // action runs, so its careful per-file validation never happens and the
        // person sees a generic failure. Split into requests that each stay
        // inside the budget the server states.
        const batches: File[][] = [];
        let batch: File[] = [];
        let batchBytes = 0;
        for (const file of usable) {
          if (batch.length > 0 && batchBytes + file.size > MAX_UPLOAD_TOTAL_BYTES) {
            batches.push(batch);
            batch = [];
            batchBytes = 0;
          }
          batch.push(file);
          batchBytes += file.size;
        }
        if (batch.length) batches.push(batch);

        let sent = 0;
        for (const [index, group] of batches.entries()) {
          const verdict = checkUploadPayload(group.map((f) => f.size));
          if (!verdict.ok) {
            setProblem(verdict.reason);
            return;
          }
          const form = new FormData();
          if (kind === "inspection") form.append("file", group[0]);
          else for (const file of group) form.append("files", file);
          setStatus(
            batches.length === 1
              ? `Uploading ${group.length} photo${group.length === 1 ? "" : "s"}…`
              : `Uploading batch ${index + 1} of ${batches.length}…`,
          );
          const posted = kind === "delivery"
            ? await uploadDeliveryPhotos(recordId, form)
            : kind === "inspection"
              ? await uploadInspectionPhoto(recordId, jobCardId ?? "", form)
              : kind === "jobcard-checkout"
                ? await uploadCheckoutPhotos(recordId, form)
                : await uploadJobCardPhotos(recordId, form);
          if (posted && "error" in posted && posted.error) {
            // Say what DID land. Reporting only the failure after two successful
            // batches would send someone back to re-upload photos already filed.
            setProblem(sent > 0 ? `${posted.error} (${sent} already uploaded)` : posted.error);
            return;
          }
          sent += group.length;
        }
        setStatus(`${sent} photo${sent === 1 ? "" : "s"} uploaded`);
        if (inputRef.current) inputRef.current.value = "";
        router.refresh();
        return;
      }

      const access = plan.access;
      for (const [index, original] of selected.entries()) {
        setStatus(`Preparing and uploading ${index + 1} of ${selected.length}…`);
        const file = await preparePhoto(original);
        if (!file.type.startsWith("image/") || file.size <= 0 || file.size > MAX_PHOTO_BYTES) {
          uploadFailures++;
          continue;
        }
        try {
          const blob = await upload(
            `uploads/${tenantId}/${kind}/${recordId}/${crypto.randomUUID()}-${file.name}`,
            file,
            {
              access,
              handleUploadUrl: "/api/photos/upload",
              clientPayload: JSON.stringify({ kind, recordId, jobCardId }),
            },
          );
          staged.push({ url: blob.url });
        } catch (error) {
          uploadFailures++;
          // KEEP THE REASON. This was a bare `catch {}`, so the one fact worth
          // having was destroyed at the moment it existed — and the message sent
          // people to a System Log that, for exactly that reason, had nothing in
          // it. Remembered here so the person is told what happened even when the
          // server-side report cannot be written.
          firstFailure = firstFailure ?? reasonOf(error);
          await reportPhotoUploadFailure(
            { kind, recordId, jobCardId },
            { stage: "transfer", fileType: file.type, fileSize: file.size, reason: reasonOf(error) },
          ).catch(() => {});
        }
      }

      if (staged.length === 0) {
        setProblem(
          firstFailure
            ? `No photos were uploaded: ${firstFailure}`
            : "No photos were uploaded, and no reason was reported.",
        );
        return;
      }
      setStatus(`Filing ${staged.length} photo${staged.length === 1 ? "" : "s"}…`);
      const result = kind === "delivery"
        ? await registerDeliveryPhotos(recordId, staged)
        : kind === "inspection"
          ? await registerInspectionPhoto(recordId, jobCardId ?? "", staged)
          : await registerJobCardPhotos(recordId, staged, kind === "jobcard-checkout" ? "checkout" : "checkin");
      if ("error" in result && result.error) {
        setProblem(result.error);
        return;
      }
      const suffix = uploadFailures
        ? ` — ${uploadFailures} could not be uploaded; retry those photos`
        : "";
      setStatus(`${result.success ?? `${staged.length} photos uploaded`}${suffix}`);
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch (error) {
      // The reason goes ON SCREEN, not only to a log the person then has to go
      // and find. This catch used to bind nothing and promise that the technical
      // reason was "recorded in Settings → System Log" — but the report it fired
      // is itself a Server Action that can fail (it re-authorises the record
      // first), and its failure was swallowed too. So the promise was routinely
      // false: an empty log, and a message insisting the answer was in it.
      const reason = reasonOf(error);
      await reportPhotoUploadFailure(
        { kind, recordId, jobCardId },
        { stage: "finalize", reason },
      ).catch(() => {});
      setProblem(`The upload did not complete: ${reason}`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className={`space-y-2 ${className}`}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*"
        disabled={working}
        className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0"
      />
      <button type="button" className="btn-secondary btn-sm w-full" disabled={working} onClick={() => void send()}>
        {working ? status ?? "Uploading…" : `📷 ${label}`}
      </button>
      {status && <p className="text-[11px] text-muted-foreground" aria-live="polite">{status}</p>}
      {problem && <p className="text-[11px] text-red-300" role="alert">{problem}</p>}
      <p className="text-[10px] text-muted-foreground">Up to {DIRECT_PHOTO_BATCH_LIMIT} photos; each is resized and uploaded separately.</p>
    </div>
  );
}
