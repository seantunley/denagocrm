"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { dismissLeadAttention } from "@/app/actions/attention";
import { MIN_DISMISS_REASON, dismissReasonError } from "@/lib/attention/score";

/**
 * "Dismiss" on one row of the Attention Centre — a dialog, never a bare button.
 *
 * ── THE REASON IS THE POINT, SO IT CANNOT BE SKIPPED ────────────────────────
 *
 * The confirm button stays disabled until the reason is long enough, and the
 * SERVER refuses a short one regardless — this dialog is a courtesy, not the
 * rule. `dismissReasonError` is shared with the action so the sentence somebody
 * reads here is the same sentence the server would have replied with.
 *
 * ── NOT OPTIMISTIC ─────────────────────────────────────────────────────────
 *
 * The row disappears on success. An optimistic removal that then failed would
 * leave somebody believing they had dealt with a deal they had not — the one
 * outcome this whole screen exists to prevent. The round trip is a single indexed
 * update; waiting for it costs nothing worth having.
 */
export default function DismissAttentionButton({ leadId, name }: { leadId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // The same check the server applies. Shown only once somebody has started
  // typing, so an untouched field is not scolded for being empty.
  const problem = reason.trim().length > 0 ? dismissReasonError(reason) : null;
  const ready = dismissReasonError(reason) === null;

  function submit() {
    if (!ready) return;
    startTransition(async () => {
      const result = await dismissLeadAttention(leadId, reason).catch(() => ({
        ok: false as const,
        error: "Couldn't dismiss this deal",
      }));
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't dismiss this deal");
        return;
      }
      setOpen(false);
      toast.success(`Dismissed ${name}`);
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setOpen(true)}>
        <X className="size-4" />
        Dismiss
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onPointerDown={(event) => event.target === event.currentTarget && setOpen(false)}
        >
          <div className="card w-full max-w-md">
            <h2 className="text-base font-semibold">Dismiss {name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              It comes off this list until somebody puts it back. Say why — this is the only record
              of the decision.
            </p>
            <textarea
              ref={inputRef}
              className="input mt-3 min-h-24 resize-y text-sm"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. Customer asked us to call back in March — diarised separately"
              aria-label="Reason for dismissing"
              aria-invalid={problem != null}
            />
            <p className="mt-1 text-[11px] text-muted-foreground" role={problem ? "alert" : undefined}>
              {problem ?? `At least ${MIN_DISMISS_REASON} characters.`}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={submit} disabled={!ready || pending}>
                {pending ? "Dismissing…" : "Dismiss"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
