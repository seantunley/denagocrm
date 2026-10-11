"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter, unstable_rethrow } from "next/navigation";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { confirmSpam, decideSender, restoreSpam } from "@/app/actions/inboundSpam";

export type QuarantineRow = {
  id: string;
  channel: string;
  /** Display name if the channel gave one, else the number / id. */
  sender: string;
  senderKey: string;
  receivedAt: string;
  /** Already made inert on the server: links cannot be clicked or unfurled. */
  preview: string;
  reason: string;
  /** "blocked" = a person's standing decision; "filter" = the automatic classification. */
  cause: "blocked" | "filter";
  confirmed: boolean;
};

const channelLabel: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };
type Filter = "all" | "filter" | "blocked";

/**
 * Inbox → Spam. Quiet on purpose: no badge colour that shouts, no notification
 * per message. Two things are kept visibly apart — what the FILTER held, and
 * what is held because a PERSON blocked the sender.
 */
export default function SpamQuarantine({ rows, canReview }: { rows: QuarantineRow[]; canReview: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [channel, setChannel] = useState("all");

  const shown = useMemo(
    () => rows.filter((r) => (filter === "all" || r.cause === filter) && (channel === "all" || r.channel === channel)),
    [rows, filter, channel],
  );
  const pickedShown = shown.filter((r) => picked.has(r.id)).map((r) => r.id);

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
  const count = (f: Filter) => rows.filter((r) => f === "all" || r.cause === f).length;

  if (!rows.length) {
    return (
      <div className="rounded-2xl border border-border bg-card p-8 text-center">
        <ShieldCheck className="mx-auto size-7 text-emerald-400" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">Nothing in quarantine</p>
        <p className="mt-1 text-xs text-muted-foreground">Messages the spam filter holds back appear here. Nothing is ever deleted from this list automatically.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {([["all", "All"], ["filter", "Held by the filter"], ["blocked", "From blocked senders"]] as [Filter, string][]).map(([key, label]) => (
          <button key={key} type="button" onClick={() => setFilter(key)} aria-pressed={filter === key}
            className={`rounded-full border px-3 py-1 text-xs ${filter === key ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}>
            {label} <span className="tabular-nums opacity-70">{count(key)}</span>
          </button>
        ))}
        <select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)} className="input h-8 w-auto py-0 text-xs">
          <option value="all">All channels</option>
          {Object.entries(channelLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {canReview && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={shown.length > 0 && pickedShown.length === shown.length}
                onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((r) => r.id)) : new Set())} />
              Select all
            </label>
            <button type="button" className="btn-secondary btn-sm" disabled={pending || pickedShown.length === 0} onClick={() => run(() => restoreSpam(pickedShown))}>
              Not spam — restore{pickedShown.length ? ` (${pickedShown.length})` : ""}
            </button>
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
                    <ShieldAlert className="size-3" aria-hidden="true" />{row.cause === "blocked" ? "You blocked this sender" : "Held by the filter"}
                  </span>
                  {row.confirmed && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">Confirmed spam</span>}
                  <time className="ml-auto text-[11px] text-muted-foreground" dateTime={row.receivedAt}>{new Date(row.receivedAt).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}</time>
                </div>
                {/* Plain text only: never a link, never an image, never unfurled. */}
                <p className="mt-1 select-text break-words text-xs text-muted-foreground">{row.preview || "(no readable text)"}</p>
                <p className="mt-1 text-[11px] text-muted-foreground/80">Why: {row.reason}</p>
              </div>
              {canReview && (
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => restoreSpam([row.id]))}>Not spam — restore</button>
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
