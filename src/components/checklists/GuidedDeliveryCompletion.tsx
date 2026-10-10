"use client";

import { useState } from "react";
import { ArrowLeft, Check, FileText, PenLine } from "lucide-react";
import { markDelivered } from "@/app/actions/fulfilment";
import { startDeliveryNoteSigning } from "@/app/actions/deliverySigning";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import { SignOnDeviceButton } from "@/components/signing/SignOnDeviceButton";
import type { DeliveryNoteSigning } from "@/components/signing/deliveryNoteSigning";
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
  signing,
}: {
  quoteId: string;
  /*
   * The runs this handover is about, chosen ONCE on the server by
   * handoverRunSelection. They drive the preview iframe AND the note the
   * customer is handed to sign, so the note they read is provably the note
   * their signature is on. Asking "which runs are newest" separately in each
   * place is what let a colleague finishing another checklist mid-review swap
   * one for the other.
   */
  runIds: string[];
  /** Where the customer's signature on the delivery note stands (lib/deliveryNoteSigning.ts). */
  signing: DeliveryNoteSigning;
}) {
  const signed = signing.kind === "signed";
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"review" | "sign">("review");
  // The customer signed, but the handover has changed since: sign for it again.
  const [again, setAgain] = useState(false);
  const runs = runIds.join(",");
  const noteHref = `/quotes/${quoteId}/delivery-note?runs=${encodeURIComponent(runs)}`;
  const previewHref = `/quotes/${quoteId}/delivery-note?embed=1&runs=${encodeURIComponent(runs)}`;
  const signHref = `/deliveries/${quoteId}/sign`;

  function start() {
    // Already signed: nothing to review again, only the delivery to complete.
    setPhase(signed ? "sign" : "review");
    setAgain(false);
    setOpen(true);
  }

  return (
    <>
      {signed && (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-300">
          <Check className="size-3.5" aria-hidden="true" /> Delivery note signed by {signing.signedByName}
        </p>
      )}
      <button type="button" onClick={start} className="btn-primary btn-sm w-full">
        <FileText className="size-3.5" aria-hidden="true" />
        {signed ? "Complete delivery" : "Review, sign & complete"}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="h-[94dvh] gap-0 p-0">
          <SheetHeader className="border-b border-border p-4 pb-3">
            <SheetTitle>Delivery handover</SheetTitle>
            <SheetDescription>
              {phase === "review"
                ? "Review the customer’s delivery note before handing over the device for signature."
                : signed && !again
                  ? "The customer has signed. Complete the delivery."
                  : "Say who is handing over the vehicle, then hand the device to the customer to sign."}
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
          ) : signed && !again ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {/* The evidence is the signed note: who handed over, which
                  checklist runs and the signature are read from it on the
                  server (deliverQuote), not from this form — which is why the
                  guided handover needs no action of its own. */}
              <SaveForm
                action={markDelivered.bind(null, quoteId)}
                success="Delivery confirmed"
                resetOnSuccess={false}
                className="space-y-4"
              >
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                  <p className="flex items-center gap-1.5 font-semibold">
                    <Check className="size-3.5" aria-hidden="true" /> Delivery note signed by {signing.signedByName}
                  </p>
                  <p className="mt-1 text-emerald-100/80">
                    {signing.sealed
                      ? "The sealed note is filed with the quote."
                      : "The sealed copy is being prepared and will be filed with the quote."}
                  </p>
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

                <SaveButton pendingLabel="Completing delivery…" className="btn-primary min-h-12 w-full">
                  <Check className="size-4" aria-hidden="true" />
                  Complete delivery
                </SaveButton>
                <button
                  type="button"
                  onClick={() => { setAgain(true); setPhase("review"); }}
                  className="w-full text-center text-xs text-muted-foreground underline hover:text-foreground"
                >
                  The handover changed since they signed? Ask the customer to sign again
                </button>
              </SaveForm>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <form onSubmit={(event) => event.preventDefault()} className="space-y-4">
                <input type="hidden" name="deliveryNoteReviewed" value="yes" />
                {/* The SAME ids the iframe above rendered. Verified server-side
                    against this quote's own completed runs — see
                    reviewedHandoverRuns — because they travel via the browser;
                    then frozen into the note the customer signs. */}
                <input type="hidden" name="runIds" value={runs} />

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
                  <p className="label">Customer signature</p>
                  <p className="text-xs text-muted-foreground">
                    The customer reads the delivery note and signs it on its own screen. Hand them this device after pressing the button, and take it back when they have signed.
                  </p>
                  {signing.kind === "open" && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      A note is already open for signing.{" "}
                      <a href={signHref} className="text-primary hover:underline">Continue with it</a>, or press the button for a fresh one.
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-[auto_1fr] gap-2 border-t border-border pt-3">
                  <button type="button" onClick={() => setPhase("review")} className="btn-secondary min-h-12 px-4">
                    <ArrowLeft className="size-4" aria-hidden="true" />
                    Note
                  </button>
                  <SignOnDeviceButton start={startDeliveryNoteSigning.bind(null, quoteId)} className="btn-primary min-h-12">
                    <PenLine className="size-4" aria-hidden="true" />
                    Customer signs on this device
                  </SignOnDeviceButton>
                </div>
              </form>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
