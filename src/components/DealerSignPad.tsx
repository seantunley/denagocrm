"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signAsDealer } from "@/app/actions/signing";

/** Denago countersignature: one click with a saved signature, or draw one. */
export default function DealerSignPad({
  quoteId,
  hasSaved,
  onSigned,
}: {
  quoteId: string;
  hasSaved: boolean;
  /** See SigningBlock's `onChanged` — an embedder whose props do not come from
   *  the route needs telling, or the pad stays up after a successful sign. */
  onSigned?: () => void;
}) {
  const router = useRouter();
  const signed = () => {
    router.refresh();
    onSigned?.();
  };
  const [padOpen, setPadOpen] = useState(false);
  const [save, setSave] = useState(true);
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

  async function useSaved() {
    setBusy(true);
    setError("");
    const r = await signAsDealer(quoteId, null, false);
    if (r.error) setError(r.error);
    else signed();
    setBusy(false);
  }

  async function submitDrawn() {
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
    const r = await signAsDealer(quoteId, out.toDataURL("image/png"), save);
    if (r.error) setError(r.error);
    else {
      setPadOpen(false);
      signed();
    }
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      {/* What "Sign as Denago" will actually stamp on the quote. The button
          committed a signature the signer had no way to look at first — and it
          goes onto a customer-facing document. */}
      {hasSaved && !previewFailed && (
        <figure className="inline-flex flex-col gap-1">
          <figcaption className="text-[11px] uppercase tracking-wide text-slate-400">Your saved signature</figcaption>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/api/me/signature"
            alt="Your saved signature"
            onError={() => setPreviewFailed(true)}
            className="h-14 w-auto max-w-full rounded-md border border-input bg-white px-2 py-1"
          />
        </figure>
      )}
      <div className="flex gap-2 flex-wrap">
        {hasSaved && (
          <button onClick={useSaved} disabled={busy} className="btn-primary">
            ✍ Sign as Denago (your saved signature)
          </button>
        )}
        <button
          onClick={() => setPadOpen(true)}
          disabled={busy}
          className={hasSaved ? "btn-secondary" : "btn-primary"}
        >
          {hasSaved ? "Draw a new signature" : "✍ Draw signature & sign"}
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {padOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onPointerDown={(e) => e.target === e.currentTarget && setPadOpen(false)}
        >
          <div className="card w-full max-w-lg">
            <h3 className="font-bold text-white mb-3">Draw your signature</h3>
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
              className="w-full h-40 rounded-lg bg-white touch-none cursor-crosshair"
            />
            <div className="flex items-center justify-between mt-3 gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  const c = canvasRef.current!;
                  c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
                  hasInk.current = false;
                }}
                className="text-sm text-slate-400 hover:text-slate-200 underline cursor-pointer"
              >
                Clear
              </button>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={save}
                  onChange={(e) => setSave(e.target.checked)}
                  className="h-4 w-4"
                />
                Save as my signature for next time
              </label>
              <div className="flex gap-2">
                <button onClick={() => setPadOpen(false)} className="btn-secondary">
                  Cancel
                </button>
                <button onClick={submitDrawn} disabled={busy} className="btn-primary">
                  {busy ? "Signing…" : "Sign quote"}
                </button>
              </div>
            </div>
            {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
