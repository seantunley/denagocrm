"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { prepareTriageAction, runTriageAction, sendTriageDraftAction } from "@/app/actions/triage";
import { formatDateTime } from "@/lib/format";
import type { TriageCardStatus } from "@/lib/triageRules";

type CardView = { id: string; kind: string; title: string; reason: string | null; channel?: string; subject?: string | null; body?: string };
type Item = {
  leadId: string; name: string; opportunity: string | null; ownerName: string | null; reasons: string[]; why: string | null;
  cards: { status: TriageCardStatus; result?: string; card: CardView }[];
};
type Run = { id: string; preparedAt: string; items: Item[]; repliedSince: string[]; outcome: { acted: number; replied: number } };

const STATUS_LABEL: Record<TriageCardStatus, string> = {
  proposed: "", running: "Doing it…", done: "Done", sent: "Sent", failed: "Not done", unsure: "Check this", skipped: "Skipped",
};

type Result = { error?: string; success?: string } | void;
const say = (result: Result) => {
  if (result && "error" in result && result.error) toast.error(String(result.error));
  else if (result && "success" in result && result.success) toast.success(String(result.success));
};

export default function TriageBoard({ run }: { run: Run | null }) {
  const [pending, start] = useTransition();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const toggle = (id: string) => setTicked((now) => { const next = new Set(now); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const prepare = () => start(async () => { say(await prepareTriageAction()); setTicked(new Set()); });

  if (!run) {
    return (
      <div className="card space-y-3 p-5">
        <p className="text-sm text-muted-foreground">DAX reads the deals that need you — the same list as the Attention Centre — and prepares what to do about each. It takes a minute.</p>
        <button type="button" className="btn-primary" disabled={pending} onClick={prepare}>{pending ? "DAX is going through them…" : "Prepare"}</button>
      </div>
    );
  }

  const tickable = run.items.flatMap((item) => item.cards.filter((c) => c.card.kind !== "draft_message" && (c.status === "proposed" || c.status === "failed")).map((c) => c.card.id));
  const chosen = tickable.filter((id) => ticked.has(id));

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-3 p-4 text-sm">
        <span>Prepared {formatDateTime(new Date(run.preparedAt))} · {run.items.length} deals</span>
        {run.outcome.acted > 0 && <span className="text-muted-foreground">Acted on {run.outcome.acted} · {run.outcome.replied} customer{run.outcome.replied === 1 ? " has" : "s have"} replied since</span>}
        <span className="ml-auto flex flex-wrap gap-2">
          <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => setTicked(new Set(tickable))}>Tick all</button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={pending || chosen.length === 0}
            onClick={() => start(async () => { say(await runTriageAction(run.id, chosen)); setTicked(new Set()); })}
          >
            {pending ? "Working…" : chosen.length ? `Do the ${chosen.length} ticked` : "Do the ticked"}
          </button>
          <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={prepare}>Prepare again</button>
        </span>
      </div>

      <ul className="space-y-3">
        {run.items.map((item) => (
          <li key={item.leadId} className="card space-y-3 p-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Link href={`/leads/${item.leadId}`} className="font-semibold text-primary hover:underline">{item.name}</Link>
              {item.opportunity && <span className="text-sm text-muted-foreground">{item.opportunity}</span>}
              <span className="text-xs text-muted-foreground">Owner: {item.ownerName ?? "nobody"}</span>
              {run.repliedSince.includes(item.leadId) && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-400">Replied since</span>}
            </div>
            <ul className="list-disc pl-5 text-xs text-muted-foreground">{item.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            {item.why && <p className="text-sm"><span className="font-medium">DAX: </span>{item.why}</p>}
            {item.cards.length === 0 && <p className="text-xs text-muted-foreground">Nothing proposed — open the deal to decide.</p>}
            {item.cards.map(({ card, status, result }) => (
              <div key={card.id} className="rounded-xl border border-border p-3">
                {card.kind === "draft_message" ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">{card.title} <span className="text-xs font-normal text-muted-foreground">· {card.channel}</span></p>
                    {status === "proposed" || status === "failed" ? (
                      <>
                        <textarea
                          className="input w-full text-sm"
                          rows={4}
                          value={drafts[card.id] ?? card.body ?? ""}
                          onChange={(event) => setDrafts((now) => ({ ...now, [card.id]: event.target.value }))}
                          aria-label={`Message to ${item.name}`}
                        />
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          disabled={pending}
                          onClick={() => start(async () => say(await sendTriageDraftAction(run.id, card.id, drafts[card.id] ?? card.body ?? "", card.subject ?? undefined)))}
                        >
                          Send to {item.name}
                        </button>
                      </>
                    ) : (
                      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{drafts[card.id] ?? card.body}</p>
                    )}
                  </div>
                ) : (
                  <label className="flex items-start gap-2 text-sm">
                    {(status === "proposed" || status === "failed") && (
                      <input type="checkbox" className="mt-1" checked={ticked.has(card.id)} disabled={pending} onChange={() => toggle(card.id)} />
                    )}
                    <span>
                      <span className="font-medium">{card.title}</span>
                      {card.reason && <span className="block text-xs text-muted-foreground">{card.reason}</span>}
                    </span>
                  </label>
                )}
                {(STATUS_LABEL[status] || result) && (
                  <p className={`mt-2 text-xs ${status === "done" || status === "sent" ? "text-emerald-400" : status === "proposed" ? "text-muted-foreground" : "text-amber-400"}`}>
                    {STATUS_LABEL[status]}{result ? `${STATUS_LABEL[status] ? " — " : ""}${result}` : ""}
                  </p>
                )}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
