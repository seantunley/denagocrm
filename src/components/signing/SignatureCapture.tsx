"use client";

import { useRef, useState } from "react";
import { saveMySignature } from "@/app/actions/signing";

/**
 * Capture (or replace) the signer's reusable signature.
 *
 * This used to be half a signing flow: the pad drew a signature AND stamped it
 * onto the quote in one action, on columns the envelope the customer received
 * knew nothing about. It now does only the part that was ever really separate —
 * storing the image against the user. Countersigning is a distinct, single act
 * performed on the envelope itself.
 */
export default function SignatureCapture({
  hasSaved,
  onSaved,
  compact = false,
}: {
  hasSaved: boolean;
  onSaved: () => void;
  /** Inline variant for the signature card, where the heading is already there. */
  compact?: boolean;
}) {
  const [padOpen, setPadOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A ref can outlive its bytes (storage wiped, restored backup). Drop the
  // preview rather than leave a broken-image frame next to a sign button.
  const [previewFailed, setPreviewFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * e.currentTarget.width) / rect.width,
      y: ((e.clientY - rect.top) * e.currentTarget.height) / rect.height,
    };
  }

  async function submit() {
    if (!hasInk.current) {
      setError("Draw your signature first.");
      return;
    }
    setBusy(true);
    setError("");
    const canvas = canvasRef.current!;
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    const result = await saveMySignature(out.toDataURL("image/png"));
    if (result.error) setError(result.error);
    else {
      setPadOpen(false);
      setPreviewFailed(false);
      onSaved();
    }
    setBusy(false);
  }

  return (
    <div className={compact ? "" : "space-y-3"}>
      <div className="flex flex-wrap items-end gap-3">
        {hasSaved && !previewFailed && (
          <figure className="inline-flex flex-col gap-1">
            <figcaption className="text-[11px] uppercase tracking-wide text-slate-400">Your signature</figcaption>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/api/me/signature"
              alt="Your saved signature"
              onError={() => setPreviewFailed(true)}
              className="h-12 w-auto max-w-full rounded-md border border-input bg-white px-2 py-1"
            />
          </figure>
        )}
        <button
          onClick={() => setPadOpen(true)}
          disabled={busy}
          className={hasSaved ? "btn-secondary btn-sm" : "btn-primary"}
        >
          {hasSaved ? "Change signature" : "✍ Add your signature"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      {padOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
          onPointerDown={(e) => e.target === e.currentTarget && setPadOpen(false)}
        >
          <div className="card w-full max-w-lg">
            <h3 className="mb-1 font-bold text-white">Draw your signature</h3>
            <p className="mb-3 text-xs text-slate-400">
              Saved to your profile and reused every time you countersign — you only do this once.
            </p>
            <canvas
              ref={canvasRef}
              width={600}
              height={180}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                drawing.current = true;
                const ctx = e.currentTarget.getContext("2d")!;
                const p = pos(e);
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return;
                const ctx = e.currentTarget.getContext("2d")!;
                ctx.strokeStyle = "#0f172a";
                ctx.lineWidth = 2.5;
                ctx.lineCap = "round";
                const p = pos(e);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
                hasInk.current = true;
              }}
              onPointerUp={() => (drawing.current = false)}
              onPointerLeave={() => (drawing.current = false)}
              className="h-40 w-full cursor-crosshair touch-none rounded-lg bg-white"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  const c = canvasRef.current!;
                  c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
                  hasInk.current = false;
                }}
                className="cursor-pointer text-sm text-slate-400 underline hover:text-slate-200"
              >
                Clear
              </button>
              <div className="flex gap-2">
                <button onClick={() => setPadOpen(false)} className="btn-secondary">
                  Cancel
                </button>
                <button onClick={submit} disabled={busy} className="btn-primary">
                  {busy ? "Saving…" : "Save signature"}
                </button>
              </div>
            </div>
            {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
