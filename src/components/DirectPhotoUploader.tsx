"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { registerDeliveryPhotos } from "@/app/actions/fulfilment";
import { reportPhotoUploadFailure } from "@/app/actions/photoUploads";
import { registerInspectionPhoto, registerJobCardPhotos } from "@/app/actions/jobcards";
import { DIRECT_PHOTO_BATCH_LIMIT } from "@/lib/photoBudget";
/*
 * `preparePhoto`, `unsendablePhoto` and the blob-path arithmetic used to be
 * written out here. They moved to lib/photoTransport.ts when the guided
 * checklist runner became a second sender: the pathname this builds has to match
 * the prefix `/api/photos/upload` checks before it will sign anything, and two
 * copies of that string is how one caller ends up silently unable to upload.
 * The loop below — one request per file, so nothing accumulates into a Server
 * Action body — is still this component's own and is what keeps a batch under
 * the framework's limit.
 */
import { preparePhoto, unsendablePhoto, uploadPhoto } from "@/lib/photoTransport";

type Kind = "delivery" | "jobcard" | "jobcard-checkout" | "inspection";

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
    try {
      for (const [index, original] of selected.entries()) {
        setStatus(`Preparing and uploading ${index + 1} of ${selected.length}…`);
        const file = await preparePhoto(original);
        if (unsendablePhoto(file)) {
          uploadFailures++;
          continue;
        }
        try {
          const url = await uploadPhoto({ kind, recordId, jobCardId, tenantId }, file);
          staged.push({ url });
        } catch {
          uploadFailures++;
          await reportPhotoUploadFailure(
            { kind, recordId, jobCardId },
            { stage: "transfer", fileType: file.type, fileSize: file.size },
          ).catch(() => {});
        }
      }

      if (staged.length === 0) {
        setProblem("No photos were uploaded. The failure is recorded in Settings → System Log.");
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
    } catch {
      await reportPhotoUploadFailure({ kind, recordId, jobCardId }, { stage: "finalize" }).catch(() => {});
      setProblem("The upload did not complete. The technical reason is recorded in Settings → System Log.");
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
