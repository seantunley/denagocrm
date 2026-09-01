"use client";
import { toast } from "sonner";

import type { ActionResult } from "@/lib/actionResultTypes";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useOptionalOffline } from "@/components/OfflineProvider";
import type { OfflineDescriptor } from "@/lib/offlineTypes";
import ModalPortal from "@/components/ui/modal-portal";

type Shot = { url: string; blob: Blob };

/**
 * Live camera capture for job-card condition photos. Uses getUserMedia, so it works
 * with a desktop webcam as well as a phone's rear camera (the file input's
 * capture="environment" only triggers a camera on mobile — desktops ignore it).
 *
 * `action` is a bound upload server action (uploadJobCardPhotos / uploadCheckoutPhotos
 * already bound to the job-card id); captured frames are handed to it as `files`,
 * exactly like the file-picker upload.
 */
export function CameraCapture({
  action,
  label = "Use camera",
  offlineOperation,
}: {
  // Accepts converted actions too. CameraCapture invokes the action directly
  // rather than through a form, so it has no SaveForm to report through — its
  // own capture UI is the feedback here.
  action: (formData: FormData) => Promise<ActionResult | void>;
  label?: string;
  offlineOperation?: OfflineDescriptor;
}) {
  const router = useRouter();
  const offline = useOptionalOffline();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [shots, setShots] = useState<Shot[]>([]);
  const [saving, setSaving] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setReady(false);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser doesn't support camera access.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setReady(true);
    } catch (e) {
      const name = (e as { name?: string })?.name;
      setError(
        name === "NotAllowedError"
          ? "Camera permission was blocked. Allow camera access in your browser, or use “Choose files”."
          : name === "NotFoundError"
            ? "No camera was found on this device."
            : "Could not start the camera. Use “Choose files” instead.",
      );
    }
  }, [facing]);

  // (Re)start the stream whenever the modal opens or the facing mode changes.
  useEffect(() => {
    if (!open) return;
    start();
    return stop;
  }, [open, facing, start, stop]);

  // Release the camera if the component unmounts while open.
  useEffect(() => stop, [stop]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (blob) setShots((s) => [...s, { url: URL.createObjectURL(blob), blob }]);
      },
      "image/jpeg",
      0.9,
    );
  };

  const removeShot = (i: number) => {
    setShots((s) => {
      URL.revokeObjectURL(s[i].url);
      return s.filter((_, idx) => idx !== i);
    });
  };

  const close = () => {
    stop();
    shots.forEach((s) => URL.revokeObjectURL(s.url));
    setShots([]);
    setError(null);
    setOpen(false);
  };

  const upload = async () => {
    if (!shots.length) return;
    setSaving(true);
    try {
      const fd = new FormData();
      shots.forEach((s, i) =>
        fd.append("files", new File([s.blob], `camera-${i + 1}.jpg`, { type: "image/jpeg" })),
      );
      const queuedOffline = Boolean(offline && !offline.online);
      if (queuedOffline) {
        if (!offlineOperation) {
          setError("This photo operation requires an internet connection.");
          return;
        }
        await offline!.queue(offlineOperation, fd);
      } else {
        const result = await action(fd);
        // On refusal: keep the captured shots and say why, so the photos are not
        // lost and the person can retry or recapture.
        if (result && typeof result === "object" && "error" in result && result.error) {
          setError(String(result.error));
          return;
        }
        toast.success(
          result && typeof result === "object" && "success" in result && result.success
            ? String(result.success)
            : "Photos uploaded",
        );
        router.refresh();
      }
      close();
    } catch {
      setError("Upload failed. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary btn-sm">
        📷 {label}
      </button>

      {open && (
        <ModalPortal>
        <div className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-[#0b0d10] px-3 py-2">
            <span className="text-sm font-semibold text-white">Take a photo</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
                className="btn-secondary btn-sm"
                title="Switch camera"
              >
                ⇄ Flip
              </button>
              <button type="button" onClick={close} className="btn-secondary btn-sm">
                Cancel
              </button>
            </div>
          </div>

          <div className="flex flex-1 items-center justify-center overflow-hidden p-4">
            {error ? (
              <div className="max-w-sm text-center">
                <p className="text-sm text-slate-200">{error}</p>
                <button type="button" onClick={start} className="btn-secondary btn-sm mt-3">
                  Try again
                </button>
              </div>
            ) : (
              <video
                ref={videoRef}
                playsInline
                muted
                className="max-h-full max-w-full rounded-lg bg-black shadow-2xl"
              />
            )}
          </div>

          {shots.length > 0 && (
            <div className="flex gap-2 overflow-x-auto border-t border-white/10 bg-[#0b0d10] px-3 py-2">
              {shots.map((s, i) => (
                <div key={s.url} className="relative shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.url} alt={`Capture ${i + 1}`} className="h-16 w-16 rounded-md border border-white/20 object-cover" />
                  <button
                    type="button"
                    onClick={() => removeShot(i)}
                    className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-red-600 text-[11px] font-bold text-white"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-center gap-3 border-t border-white/10 bg-[#0b0d10] px-3 py-3">
            <button type="button" onClick={capture} disabled={!ready} className="btn-secondary disabled:opacity-40">
              ● Capture
            </button>
            <button type="button" onClick={upload} disabled={!shots.length || saving} className="btn-primary disabled:opacity-40">
              {saving ? "Uploading…" : `Upload ${shots.length || ""} photo${shots.length === 1 ? "" : "s"}`.trim()}
            </button>
          </div>
        </div>
        </ModalPortal>
      )}
    </>
  );
}
