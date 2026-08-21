"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { useRouter } from "next/navigation";
import { registerDeliveryPhotos } from "@/app/actions/fulfilment";
import { registerInspectionPhoto, registerJobCardPhotos } from "@/app/actions/jobcards";
import {
  DIRECT_PHOTO_BATCH_LIMIT,
  MAX_PHOTO_BYTES,
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_EDGE,
  fitWithinMaxEdge,
} from "@/lib/photoBudget";

type Kind = "delivery" | "jobcard" | "jobcard-checkout" | "inspection";

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
    try {
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
              access: "public",
              handleUploadUrl: "/api/photos/upload",
              clientPayload: JSON.stringify({ kind, recordId, jobCardId }),
            },
          );
          staged.push({ url: blob.url });
        } catch {
          uploadFailures++;
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
