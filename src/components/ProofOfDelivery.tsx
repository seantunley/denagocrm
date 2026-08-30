"use client";

import { useRef, useState } from "react";
import { markDelivered } from "@/app/actions/fulfilment";
import { SaveForm, SaveButton } from "@/components/SaveForm";

const CHECKLIST = [
  "Battery fully charged",
  "Charger & cable handed over",
  "Keys handed over",
  "Owner's manual provided",
  "Controls & safety walkthrough done",
  "Cart inspected — no visible damage",
];

export default function ProofOfDelivery({ quoteId, baseVersion }: { quoteId: string; baseVersion: string }) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [sig, setSig] = useState("");
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

  function captureSignature() {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk.current) {
      setSig("");
      return;
    }
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    setSig(out.toDataURL("image/png"));
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="btn bg-emerald-700 text-white hover:bg-emerald-600 btn-sm w-full mt-2"
      >
        ✓ Complete delivery
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-10 overflow-y-auto"
          onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="card w-full max-w-lg">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold text-white">Proof of delivery</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-white text-2xl leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <SaveForm
              action={markDelivered.bind(null, quoteId)}
              success="Delivery confirmed"
              resetOnSuccess={false}
              offlineOperation={{ type: "delivery.complete", recordId: quoteId, baseVersion }}
              className="space-y-4"
            >
              <div>
                <label className="label">Delivered by (driver)</label>
                <input name="deliveredByName" className="input" placeholder="Who handed it over" />
              </div>

              <div>
                <label className="label">Handover checklist</label>
                <div className="space-y-1.5">
                  {CHECKLIST.map((item) => (
                    <label key={item} className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-orange-600"
                        checked={!!checked[item]}
                        onChange={(e) => setChecked((c) => ({ ...c, [item]: e.target.checked }))}
                      />
                      {item}
                    </label>
                  ))}
                </div>
                <input type="hidden" name="checklist" value={JSON.stringify(checked)} />
              </div>

              <div>
                <label className="label">Customer signature</label>
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
                  onPointerUp={() => {
                    drawing.current = false;
                    captureSignature();
                  }}
                  onPointerLeave={() => {
                    drawing.current = false;
                    captureSignature();
                  }}
                  className="w-full h-40 rounded-lg bg-white touch-none cursor-crosshair"
                />
                <input type="hidden" name="signature" value={sig} />
                <button
                  type="button"
                  onClick={() => {
                    const c = canvasRef.current!;
                    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
                    hasInk.current = false;
                    setSig("");
                  }}
                  className="text-xs text-slate-400 hover:text-slate-200 underline mt-1"
                >
                  Clear signature
                </button>
              </div>

              <div>
                <label className="label">Signed delivery note (optional)</label>
                <input
                  type="file"
                  name="file"
                  accept=".pdf,image/*"
                  className="block w-full text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0"
                />
              </div>

              <SaveButton
                pendingLabel="Confirming…"
                className="btn bg-emerald-700 text-white hover:bg-emerald-600 w-full"
              >
                ✓ Confirm delivery → register vehicle
              </SaveButton>
            </SaveForm>
          </div>
        </div>
      )}
    </>
  );
}
