"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CalendarClock, X } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { dismissLeadAttention, snoozeLeadAttention } from "@/app/actions/attention";
import {
  MAX_SNOOZE_DAYS,
  MIN_ATTENTION_REASON,
  attentionReasonError,
  snoozeDateError,
} from "@/lib/attention/score";
import type { AttentionSignalKind } from "@/lib/attention/score";

/**
 * The two ways off the Attention Centre, in one dialog.
 *
 * ── TWO TOOLS, BECAUSE THEY ARE TWO DECISIONS ───────────────────────────────
 *
 *   SNOOZE   nothing is wrong — come back on a date. The commonest case by far:
 *            "in Italy at the moment, back on the 19th".
 *   DISMISS  this does not belong on the list at all.
 *
 * One component rather than two, because everything except the date field is the
 * same — the reason rule, the validation shared with the server, the
 * non-optimistic submit — and two copies would drift the first time one of them
 * changed.
 *
 * ── THE REASON IS THE POINT, SO IT CANNOT BE SKIPPED ────────────────────────
 *
 * The confirm button stays disabled until the reason is long enough and, for a
 * snooze, until the date is sane. The SERVER refuses either regardless: this
 * dialog is a courtesy, not the rule. `attentionReasonError` and `snoozeDateError`
 * are shared with the actions, so the sentence somebody reads here is the sentence
 * the server would have replied with.
 *
 * ── NOT OPTIMISTIC ─────────────────────────────────────────────────────────
 *
 * The row disappears on success. An optimistic removal that then failed would
 * leave somebody believing they had dealt with a deal they had not — the one
 * outcome this whole screen exists to prevent.
 */
export default function SetAsideAttentionButton({
  leadId,
  name,
  mode,
  signalKey,
  signalKind,
}: {
  leadId: string;
  name: string;
  mode: "snooze" | "dismiss";
  signalKey: string;
  signalKind: AttentionSignalKind;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
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

  const snoozing = mode === "snooze";
  // `<input type="date">` yields YYYY-MM-DD, which parses as UTC midnight. Read
  // back through the same Date the server will build, so the two agree about
  // which day was chosen.
  const untilDate = until ? new Date(until) : null;
  const dateProblem = snoozing ? snoozeDateError(untilDate, new Date()) : null;
  // Shown only once somebody has started typing, so an untouched field is not
  // scolded for being empty.
  const reasonProblem = reason.trim().length > 0 ? attentionReasonError(reason, mode) : null;
  const ready = attentionReasonError(reason, mode) === null && !dateProblem;

  // The date input's own bounds, so the picker cannot offer what the server would
  // refuse. Belt and braces with snoozeDateError, which is the actual rule.
  const today = new Date();
  const maxDate = new Date(today.getTime() + MAX_SNOOZE_DAYS * 24 * 60 * 60 * 1000);
  const iso = (value: Date) => value.toISOString().slice(0, 10);

  function submit() {
    if (!ready) return;
    startTransition(async () => {
      const result = await (snoozing
        ? snoozeLeadAttention(leadId, until, reason, signalKey, signalKind)
        : dismissLeadAttention(leadId, reason, signalKey, signalKind)
      ).catch(() => ({ ok: false as const, error: `Couldn't ${mode} this deal` }));
      if (!result.ok) {
        toast.error(result.error ?? `Couldn't ${mode} this deal`);
        return;
      }
      setOpen(false);
      toast.success(snoozing ? `Snoozed ${name}` : `Dismissed ${name}`);
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setOpen(true)}>
        {snoozing ? <CalendarClock className="size-4" /> : <X className="size-4" />}
        {snoozing ? "Snooze" : "Dismiss"}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onPointerDown={(event) => event.target === event.currentTarget && setOpen(false)}
        >
          <div className="card w-full max-w-md">
            <h2 className="text-base font-semibold">
              {snoozing ? "Snooze" : "Dismiss"} {name}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {snoozing
                ? "It comes back on the date you pick. Say why — it is what the next person reads when it returns."
                : "It comes off this list until somebody puts it back. Say why — this is the only record of the decision."}
            </p>

            {snoozing && (
              <div className="mt-3">
                <label className="label" htmlFor="attention-snooze-until">
                  Come back on
                </label>
                <input
                  id="attention-snooze-until"
                  type="date"
                  className="input"
                  value={until}
                  min={iso(today)}
                  max={iso(maxDate)}
                  onChange={(event) => setUntil(event.target.value)}
                  aria-invalid={dateProblem != null}
                />
                {dateProblem && until !== "" && (
                  <p className="mt-1 text-[11px] text-destructive" role="alert">
                    {dateProblem}
                  </p>
                )}
              </div>
            )}

            <label className="label mt-3" htmlFor="attention-reason">
              Reason
            </label>
            <textarea
              id="attention-reason"
              ref={inputRef}
              className="input min-h-24 resize-y text-sm"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                snoozing
                  ? "e.g. Customer in Italy until the 19th — agreed to call then"
                  : "e.g. Duplicate of the other Rover XL enquiry — working that one"
              }
              aria-invalid={reasonProblem != null}
            />
            <p className="mt-1 text-[11px] text-muted-foreground" role={reasonProblem ? "alert" : undefined}>
              {reasonProblem ?? `At least ${MIN_ATTENTION_REASON} characters.`}
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={submit} disabled={!ready || pending}>
                {pending ? "Saving…" : snoozing ? "Snooze" : "Dismiss"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
