"use client";

import { useEffect, useRef, useState } from "react";
import {
  MAX_PHOTOS,
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_EDGE,
  checkUploadPayload,
  fitWithinMaxEdge,
} from "@/lib/photoBudget";

/**
 * A camera/file field that SHRINKS photos before they are submitted.
 *
 * Drop-in for the `<input type="file" name="files" multiple accept="image/*"
 * capture="environment">` fields the mobile capture flow uses. It keeps the same
 * name and the same enclosing `<form action={serverAction}>`; what changes is that
 * the files reaching the action are resized copies.
 *
 * Why this exists: a Server Action request body is capped at 1 MB by default, and
 * an ordinary phone photo is 3–12 MB. The framework rejected the request before
 * the upload action's own validation ran, so the camera button worked on a desktop
 * review and would not have worked on a phone. Raising the limit to 48 MB to match
 * what the action advertises would have made the feature technically function by
 * pushing tens of megabytes of unnecessary pixels over a mobile connection.
 *
 * Resizing on the client fixes the cause: 1600px on the longest edge is more than
 * a reviewer can use on screen, and it is roughly a sixth of the bytes.
 */
export default function PhotoUploadField({
  name = "files",
  required = false,
  className,
  maxPhotos = MAX_PHOTOS,
}: {
  name?: string;
  required?: boolean;
  className?: string;
  maxPhotos?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  /**
   * Have the CURRENT files been through resizing?
   *
   * A ref, not state: the submit handler below reads it during the event, and a
   * state value captured in a closure could be a render behind — which is exactly
   * the race this exists to close.
   */
  const preparedRef = useRef(false);

  async function shrink(file: File): Promise<File> {
    // Anything that is not an image, or that the browser cannot decode, is passed
    // through untouched — the server validates type and size regardless, and
    // silently dropping a file the person selected would be worse than sending it.
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
      return file; // already small enough; re-encoding would only lose quality
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
    if (!blob) return file;
    // A resize that made the file BIGGER is not an improvement — a small PNG
    // screenshot re-encoded as JPEG can do that. Keep whichever is smaller.
    if (blob.size >= file.size) return file;
    const renamed = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${renamed}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
  }

  /**
   * Resize the current selection and replace the input's files with the results.
   * Returns whether the batch is sendable. Safe to call twice — the second call
   * finds already-small files and leaves them alone.
   */
  async function prepare(): Promise<boolean> {
    const input = inputRef.current;
    const picked = [...(input?.files ?? [])];
    if (picked.length === 0) {
      setStatus(null);
      setProblem(null);
      preparedRef.current = true;
      return true;
    }
    setWorking(true);
    setProblem(null);
    setStatus(`Preparing ${picked.length} photo${picked.length === 1 ? "" : "s"}…`);
    try {
      const shrunk = await Promise.all(picked.map(shrink));
      const verdict = checkUploadPayload(shrunk.map((file) => file.size), { maxPhotos });

      // The resized files replace the input's own selection, so the enclosing form
      // submits these and the Server Action needs no knowledge of any of this.
      const transfer = new DataTransfer();
      for (const file of shrunk) transfer.items.add(file);
      if (input) input.files = transfer.files;

      if (!verdict.ok) {
        setProblem(verdict.reason);
        setStatus(null);
        // NOT prepared: an over-limit batch must keep being stopped at submit,
        // not waved through on the second attempt.
        preparedRef.current = false;
        return false;
      }
      const before = picked.reduce((sum, file) => sum + file.size, 0);
      const saved = before - verdict.total;
      setStatus(
        saved > 0
          ? `${shrunk.length} photo${shrunk.length === 1 ? "" : "s"} ready · ${fmt(verdict.total)} (was ${fmt(before)})`
          : `${shrunk.length} photo${shrunk.length === 1 ? "" : "s"} ready · ${fmt(verdict.total)}`,
      );
      preparedRef.current = true;
      return true;
    } finally {
      setWorking(false);
    }
  }

  /** Always the CURRENT prepare, so the once-bound submit listener cannot go stale. */
  const prepareRef = useRef(prepare);
  useEffect(() => {
    prepareRef.current = prepare;
  });

  /**
   * THE SUBMIT BOUNDARY.
   *
   * Resizing on `change` alone was a race: on a phone the decode of five camera
   * photos takes a moment, and nothing stopped the person tapping Upload during
   * it. The form then submitted the ORIGINAL files — tens of megabytes, refused by
   * the framework before the action ran — and the resize finished afterwards,
   * pointlessly. `working` only changed a status line; it disabled nothing.
   *
   * So the component owns submission instead of decorating it. On the capture
   * phase, before the form's own handler runs: if the selected files have not been
   * prepared, stop the event, prepare them, and submit again. The second submit
   * finds `preparedRef` true and passes straight through.
   *
   * Capture phase matters — a bubble-phase listener would run after React's own
   * form handling had already started the action.
   *
   * `prepare` is reached through a ref rather than captured: the listener is bound
   * once, and a closure over the first render's function would go stale the moment
   * a prop it reads changed. eslint's react-hooks/immutability caught that.
   */
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;

    const onSubmit = (event: Event) => {
      const input = inputRef.current;
      if (!input) return;
      // Nothing chosen, or already prepared: this submit is fine as it stands.
      if (!input.files || input.files.length === 0) return;
      if (preparedRef.current) return;

      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        const ok = await prepareRef.current();
        // Only submit if the payload is actually sendable. Re-submitting a batch
        // that is over the limit would just reproduce the failure it was caught to
        // prevent, and the reason is already on screen.
        if (ok) form.requestSubmit();
      })();
    };

    form.addEventListener("submit", onSubmit, { capture: true });
    return () => form.removeEventListener("submit", onSubmit, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onPick() {
    // A new selection is unprepared by definition. Preparing eagerly here keeps
    // the common case instant — by the time Upload is tapped the work is usually
    // done — but the submit handler is what GUARANTEES it, not this.
    preparedRef.current = false;
    void prepare();
  }

  return (
    <div className="space-y-1">
      <input
        ref={inputRef}
        type="file"
        name={name}
        multiple
        required={required}
        accept="image/*"
        capture="environment"
        onChange={onPick}
        className={className}
      />
      {working && <p className="text-[11px] text-muted-foreground">Resizing…</p>}
      {!working && status && <p className="text-[11px] text-muted-foreground">{status}</p>}
      {problem && <p className="text-[11px] text-amber-300">{problem}</p>}
    </div>
  );
}

function fmt(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
