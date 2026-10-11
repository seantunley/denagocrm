"use client";

import { useState, useTransition } from "react";
import { useRouter, unstable_rethrow } from "next/navigation";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { confirmSpam, correctObservedSpam, decideSender, restoreSpam } from "@/app/actions/inboundSpam";

export type QuarantineRow = {
  id: string;
  channel: string;
  /** Display name if the channel gave one, else the number / id. */
  sender: string;
  receivedAt: string;
  /** Already made inert on the server: links cannot be clicked or unfurled. */
  preview: string;
  fullText: string;
  state: string;
  observed: boolean;
  staffLabel: string | null;
  reason: string;
  /** "blocked" = a person's standing decision; "filter" = the automatic classification. */
  cause: "blocked" | "filter";
};

const channelLabel: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };

/**
 * Inbox → Spam. Quiet on purpose: no badge colour that shouts, no notification
 * per message. Two things are kept visibly apart — what the FILTER held, and
 * what is held because a PERSON blocked the sender.
 */
export default function SpamQuarantine({ rows, canReview }: { rows: QuarantineRow[]; canReview: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const shown = rows;
  const pickedShown = shown.filter((r) => picked.has(r.id)).map((r) => r.id);
  const restorable = (r: QuarantineRow) => r.state === "quarantined" || r.state === "restoring";
  const restoreIds = shown.filter((r) => picked.has(r.id) && restorable(r)).map((r) => r.id);
  const observedIds = shown.filter((r) => picked.has(r.id) && r.observed).map((r) => r.id);

  const run = (work: () => Promise<{ error?: string; success?: string } | void>) => {
    startTransition(async () => {
      try {
        const result = await work();
        if (result && result.error) { toast.error(String(result.error)); return; }
        if (result && result.success) toast.success(String(result.success));
        setPicked(new Set());
        router.refresh();
      } catch (error) {
        unstable_rethrow(error);
        toast.error("That change did not reach the server. Refresh and try again.");
      }
    });
  };
  const toggle = (id: string) => setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  if (!rows.length) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 text-center">
        <ShieldCheck className="mx-auto size-7 text-emerald-400" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">No messages in this view</p>
        <p className="mt-1 text-xs text-muted-foreground">Try another view or search. Confirmed spam stays available in its own view.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {canReview && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={shown.length > 0 && pickedShown.length === shown.length}
                onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((r) => r.id)) : new Set())} />
              Select this page
            </label>
            {shown.some(restorable) && <button type="button" className="btn-secondary btn-sm" disabled={pending || restoreIds.length === 0} onClick={() => run(() => restoreSpam(restoreIds))}>
              Not spam — restore{restoreIds.length ? ` (${restoreIds.length})` : ""}
            </button>}
            {shown.some((r) => r.observed) && <button type="button" className="btn-secondary btn-sm" disabled={pending || observedIds.length === 0} onClick={() => run(() => correctObservedSpam(observedIds))}>
              Not spam{observedIds.length ? ` (${observedIds.length})` : ""}
            </button>}
            <button type="button" className="btn-secondary btn-sm" disabled={pending || pickedShown.length === 0} onClick={() => run(() => confirmSpam(pickedShown))}>
              Confirm spam{pickedShown.length ? ` (${pickedShown.length})` : ""}
            </button>
          </div>
        )}
      </div>

      {shown.length === 0 ? <p className="rounded-xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">Nothing matches that filter.</p> : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
          {shown.map((row) => (
            <li key={row.id} className="flex flex-wrap items-start gap-3 p-3">
              {canReview && <input type="checkbox" className="mt-1" aria-label={`Select the message from ${row.sender}`} checked={picked.has(row.id)} onChange={() => toggle(row.id)} />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{row.sender}</span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">{channelLabel[row.channel] ?? row.channel}</span>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${row.cause === "blocked" ? "bg-sky-500/10 text-sky-300" : "bg-amber-500/10 text-amber-300"}`}>
                    <ShieldAlert className="size-3" aria-hidden="true" />{row.state === "admitted" ? (row.observed ? "Observe decision — admitted" : "Admitted to inbox") : row.state === "restored" ? "Restored" : row.cause === "blocked" ? "Held by sender block" : "Held by the filter"}
                  </span>
                  {row.staffLabel && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{row.staffLabel === "spam" ? "Confirmed spam" : "Reviewed: not spam"}</span>}
                  <time className="ml-auto text-[11px] text-muted-foreground" dateTime={row.receivedAt}>{new Date(row.receivedAt).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}</time>
                </div>
                {/* Plain text only: never a link, never an image, never unfurled. */}
                <p className="mt-1 select-text break-words text-xs text-muted-foreground">{row.preview || "(no readable text)"}</p>
                {row.fullText !== row.preview && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Read full saved text</summary><p className="mt-2 select-text break-words">{row.fullText}</p></details>}
                <p className="mt-1 text-[11px] text-muted-foreground/80">Why: {row.reason}</p>
              </div>
              {canReview && (
                <div className="flex flex-wrap gap-1.5">
                  {restorable(row) && <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => restoreSpam([row.id]))}>Not spam — restore</button>}
                  {row.observed && <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => correctObservedSpam([row.id]))}>Not spam</button>}
                  {row.cause === "blocked"
                    ? <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => decideSender(row.id, "clear"))}>Unblock sender</button>
                    : <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => decideSender(row.id, "block"))}>Block sender</button>}
                  <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => decideSender(row.id, "allow"))}>Always allow sender</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
