"use client";

import { useRef, useState } from "react";
import { ArrowLeft, Check, FileText, PenLine } from "lucide-react";
import { completeGuidedDelivery } from "@/app/actions/guidedDelivery";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export default function GuidedDeliveryCompletion({
  quoteId,
  runIds,
}: {
  quoteId: string;
  /*
   * The runs this handover is about, chosen ONCE on the server by
   * handoverRunSelection. They drive the preview iframe AND the submitted form,
   * so the note the customer reads is provably the note their signature is filed
   * beside. Asking "which runs are newest" separately in each place is what let
   * a colleague finishing another checklist mid-review swap one for the other.
   */
  runIds: string[];
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"review" | "sign">("review");
  const [signature, setSignature] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const runs = runIds.join(",");
  const noteHref = `/quotes/${quoteId}/delivery-note?runs=${encodeURIComponent(runs)}`;
  const previewHref = `/quotes/${quoteId}/delivery-note?embed=1&runs=${encodeURIComponent(runs)}`;

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * event.currentTarget.width) / rect.width,
      y: ((event.clientY - rect.top) * event.currentTarget.height) / rect.height,
    };
  }

  function captureSignature() {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk.current) {
      setSignature("");
      return;
    }
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const context = out.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, out.width, out.height);
    context.drawImage(canvas, 0, 0);
    setSignature(out.toDataURL("image/png"));
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
    setSignature("");
  }

  function start() {
    setPhase("review");
    clearSignature();
    setOpen(true);
  }

  return (
    <>
      <button type="button" onClick={start} className="btn-primary btn-sm w-full">
        <FileText className="size-3.5" aria-hidden="true" />
        Review, sign &amp; complete
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="h-[94dvh] gap-0 p-0">
          <SheetHeader className="border-b border-border p-4 pb-3">
            <SheetTitle>Delivery handover</SheetTitle>
            <SheetDescription>
              {phase === "review"
                ? "Review the customer’s delivery note before handing over the phone for signature."
                : "Capture the person handing over the vehicle and the customer’s signature."}
            </SheetDescription>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
              <span className={`rounded-full px-2 py-1 text-center ${phase === "review" ? "bg-primary/15 text-primary" : "bg-emerald-500/10 text-emerald-300"}`}>
                1 · Review note
              </span>
              <span className={`rounded-full px-2 py-1 text-center ${phase === "sign" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
                2 · Sign &amp; complete
              </span>
            </div>
          </SheetHeader>

          {phase === "review" ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
              <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-white">
                <iframe
                  title="Delivery note preview"
                  src={previewHref}
                  className="h-full min-h-[52dvh] w-full bg-white"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                If the preview does not load on this device, {" "}
                <a href={noteHref} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  open the full delivery note
                </a>.
              </p>
              <button type="button" onClick={() => setPhase("sign")} className="btn-primary min-h-14 w-full text-base">
                <Check className="size-4" aria-hidden="true" />
                Delivery note reviewed — continue
              </button>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <SaveForm
                action={completeGuidedDelivery.bind(null, quoteId)}
                success="Delivery confirmed"
                resetOnSuccess={false}
                className="space-y-4"
              >
                <input type="hidden" name="deliveryNoteReviewed" value="yes" />
                {/* The SAME ids the iframe above rendered. Verified server-side
                    against this quote's own completed runs — see
                    completeGuidedDelivery — because they travel via the browser. */}
                <input type="hidden" name="runIds" value={runs} />
                <input type="hidden" name="signature" value={signature} />

                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                  <p className="flex items-center gap-1.5 font-semibold">
                    <Check className="size-3.5" aria-hidden="true" /> Guided handover complete
                  </p>
                  <p className="mt-1 text-emerald-100/80">The configured handover checklist and its evidence are complete.</p>
                </div>

                <div>
                  <label className="label" htmlFor={`delivered-by-${quoteId}`}>Handed over by</label>
                  <input
                    id={`delivered-by-${quoteId}`}
                    name="deliveredByName"
                    required
                    className="input min-h-12 text-base"
                    placeholder="Driver / staff member"
                    autoComplete="name"
                  />
                </div>

                <div>
                  <label className="label">Customer signature</label>
                  <p className="mb-2 text-xs text-muted-foreground">Hand the phone to the customer and ask them to sign below.</p>
                  <canvas
                    ref={canvasRef}
                    width={600}
                    height={220}
                    onPointerDown={(event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      drawing.current = true;
                      const context = event.currentTarget.getContext("2d");
                      if (!context) return;
                      const p = point(event);
                      context.beginPath();
                      context.moveTo(p.x, p.y);
                    }}
                    onPointerMove={(event) => {
                      if (!drawing.current) return;
                      const context = event.currentTarget.getContext("2d");
                      if (!context) return;
                      context.strokeStyle = "#0f172a";
                      context.lineWidth = 2.5;
                      context.lineCap = "round";
                      const p = point(event);
                      context.lineTo(p.x, p.y);
                      context.stroke();
                      hasInk.current = true;
                    }}
                    onPointerUp={() => {
                      drawing.current = false;
                      captureSignature();
                    }}
                    onPointerCancel={() => {
                      drawing.current = false;
                      captureSignature();
                    }}
                    onPointerLeave={() => {
                      drawing.current = false;
                      captureSignature();
                    }}
                    className="h-44 w-full touch-none cursor-crosshair rounded-xl border border-border bg-white"
                    aria-label="Customer signature pad"
                  />
                  <button type="button" onClick={clearSignature} className="mt-1 text-xs text-muted-foreground underline hover:text-foreground">
                    Clear signature
                  </button>
                </div>

                <div>
                  <label className="label" htmlFor={`signed-note-${quoteId}`}>Signed paper copy (optional)</label>
                  <input
                    id={`signed-note-${quoteId}`}
                    type="file"
                    name="file"
                    accept=".pdf,image/*"
                    className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0"
                  />
                </div>

                <div className="grid grid-cols-[auto_1fr] gap-2 border-t border-border pt-3">
                  <button type="button" onClick={() => setPhase("review")} className="btn-secondary min-h-12 px-4">
                    <ArrowLeft className="size-4" aria-hidden="true" />
                    Note
                  </button>
                  <SaveButton pendingLabel="Completing delivery…" className="btn-primary min-h-12">
                    <PenLine className="size-4" aria-hidden="true" />
                    Sign &amp; complete delivery
                  </SaveButton>
                </div>
              </SaveForm>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
