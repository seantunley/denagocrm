"use client";

import { useState } from "react";
import { markDelivered } from "@/app/actions/fulfilment";
import { startDeliveryNoteSigning } from "@/app/actions/deliverySigning";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { SignOnDeviceButton } from "@/components/signing/SignOnDeviceButton";
import type { DeliveryNoteSigning } from "@/components/signing/deliveryNoteSigning";
import ModalPortal from "@/components/ui/modal-portal";

const CHECKLIST = [
  "Battery fully charged",
  "Charger & cable handed over",
  "Keys handed over",
  "Owner's manual provided",
  "Controls & safety walkthrough done",
  "Cart inspected — no visible damage",
];

/**
 * Proof of delivery where no guided handover is set up: who handed over, the
 * built-in checklist, and the customer's signature.
 *
 * The customer signs the delivery note itself, on its own screen ("Customer
 * signs on this device") — the checklist ticked here is frozen into that note.
 * A delivery can still be confirmed without a signature, as it always could
 * here; with one, the evidence is read from the signed note on the server.
 */
export default function ProofOfDelivery({ quoteId, signing }: {
  quoteId: string;
  /** Where the customer's signature on the delivery note stands (lib/deliveryNoteSigning.ts). */
  signing: DeliveryNoteSigning;
}) {
  const signed = signing.kind === "signed";
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  // The customer signed, but the handover has changed since: sign for it again.
  const [again, setAgain] = useState(false);

  return (
    <>
      {signed && <p className="mt-2 text-[11px] text-emerald-300">✓ Delivery note signed by {signing.signedByName}</p>}
      <button
        onClick={() => { setAgain(false); setOpen(true); }}
        className="btn bg-emerald-700 text-white hover:bg-emerald-600 btn-sm w-full mt-2"
      >
        ✓ Complete delivery
      </button>

      {open && (
        <ModalPortal>
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
              className="space-y-4"
            >
              {signed && !again ? (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
                  <p className="font-semibold">✓ Delivery note signed by {signing.signedByName}</p>
                  <p className="mt-1 text-emerald-100/80">
                    {signing.sealed
                      ? "The sealed note is filed with the quote."
                      : "The sealed copy is being prepared and will be filed with the quote."}
                  </p>
                  <button type="button" onClick={() => setAgain(true)} className="mt-2 underline hover:text-white">
                    The handover changed since they signed? Ask the customer to sign again
                  </button>
                </div>
              ) : (
                <>
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
                    <p className="mb-2 text-xs text-slate-400">
                      The customer reads the delivery note — with the checklist above — and signs it on its own screen. Hand them this device after pressing the button.
                    </p>
                    <SignOnDeviceButton start={startDeliveryNoteSigning.bind(null, quoteId)} className="btn-primary w-full">
                      Customer signs on this device
                    </SignOnDeviceButton>
                    {signing.kind === "open" && (
                      <p className="mt-2 text-xs text-slate-400">
                        A note is already open for signing.{" "}
                        <a href={`/deliveries/${quoteId}/sign`} className="text-primary hover:underline">Continue with it</a>, or press the button for a fresh one.
                      </p>
                    )}
                  </div>
                </>
              )}

              {signed && again ? (
                // Asking again is the only thing to do here. Confirming now would
                // record the delivery against the signature they already gave —
                // which is one step back, said in words.
                <button type="button" onClick={() => setAgain(false)} className="w-full text-center text-xs text-slate-400 underline hover:text-white">
                  Keep the signature they gave
                </button>
              ) : (
                <>
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
                    className={signed ? "btn bg-emerald-700 text-white hover:bg-emerald-600 w-full" : "btn-secondary w-full"}
                  >
                    {signed ? "✓ Confirm delivery → register vehicle" : "Confirm delivery without a signature → register vehicle"}
                  </SaveButton>
                </>
              )}
            </SaveForm>
          </div>
        </div>
        </ModalPortal>
      )}
    </>
  );
}
