"use client";

import { useEffect, useState, useTransition } from "react";
import { History, Loader2, X } from "lucide-react";
import { listFlowReplays, replayFlowConversation } from "@/app/actions/flowReplay";
import type { ReplayConversation, ReplayResult } from "@/lib/flowReplay";
import type { ReplayStep } from "@/lib/flowReplayRun";
import { cn } from "@/lib/utils";

/**
 * "Why did the bot say that?" — pick one of this flow's real conversations; the canvas lights up the path it took
 * (FlowBuilder numbers the steps) and this panel shows each turn and the values stored along the way.
 */
export default function FlowReplayPanel({ flowId, nodeLabel, onSteps, onFocus, onClose }: {
  flowId: string;
  nodeLabel: (nodeId: string) => string | null;
  onSteps: (steps: ReplayStep[] | null) => void;
  onFocus: (nodeId: string) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<ReplayConversation[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    listFlowReplays(flowId).then(setList, () => setList([]));
  }, [flowId]);

  const replay = (eventId: string) => {
    setPicked(eventId);
    start(async () => {
      const res = await replayFlowConversation(flowId, eventId).catch((): ReplayResult => ({ ok: false, error: "The replay stopped — try again." }));
      setResult(res);
      onSteps(res.ok ? res.steps : null);
    });
  };

  return (
    <aside className="w-96 shrink-0 overflow-y-auto border-l border-white/[0.08] bg-[#111614] max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-[81] max-lg:max-h-[78dvh] max-lg:w-auto max-lg:rounded-t-3xl max-lg:border-t">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.08] bg-[#111614]/95 px-4 py-3 backdrop-blur">
        <div><p className="text-sm font-semibold text-white">Replay a conversation</p><p className="text-xs text-slate-400">See the path a real customer took, and why</p></div>
        <button type="button" onClick={onClose} className="grid size-10 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-4" /><span className="sr-only">Close replay</span></button>
      </div>
      <div className="space-y-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {list === null ? (
          <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" />Loading conversations…</p>
        ) : !list.length ? (
          <p className="text-sm leading-6 text-slate-400">No conversations on this flow&apos;s published versions in the last 30 days.</p>
        ) : (
          <div className="grid gap-1.5">
            {list.map((c) => (
              <button key={c.eventId} type="button" onClick={() => replay(c.eventId)} disabled={c.channel !== "whatsapp"}
                className={cn("rounded-lg border border-white/10 px-3 py-2 text-left text-xs text-slate-300 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50", picked === c.eventId && "border-orange-400/50 bg-orange-500/10")}
                title={c.channel !== "whatsapp" ? "Replay covers WhatsApp conversations for now" : undefined}>
                <span className="flex items-center justify-between gap-2"><span className="font-medium text-slate-100">{c.channel} {c.who}</span><span className="text-slate-500">v{c.version}</span></span>
                <span className="block text-slate-500">{new Date(c.startedAt).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })} · {c.outcome}</span>
              </button>
            ))}
          </div>
        )}

        {pending && <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" />Replaying…</p>}
        {!pending && result && !result.ok && <p className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{result.error}</p>}
        {!pending && result?.ok && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-white"><History className="size-4" />{result.steps.length} steps · {result.ended}</p>
              <button type="button" onClick={() => { setResult(null); setPicked(null); onSteps(null); }} className="text-xs text-orange-300 hover:underline">Clear</button>
            </div>
            <p className={cn("rounded-lg border px-3 py-2 text-xs leading-5", result.check.matches ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100" : "border-amber-400/40 bg-amber-500/10 text-amber-100")}>{result.check.text}</p>
            {result.notes.map((note) => <p key={note} className="text-[11px] leading-4 text-slate-500">{note}</p>)}
            {result.turns.map((t) => (
              <div key={t.turn} className="space-y-1.5 rounded-lg border border-white/10 p-2.5">
                <p className="rounded-md bg-emerald-500/10 px-2 py-1 text-xs text-emerald-100"><span className="text-emerald-400">Customer: </span>{t.customer || "—"}</p>
                {result.steps.filter((s) => s.turn === t.turn).map((s) => (
                  <button key={s.order} type="button" onClick={() => onFocus(s.nodeId)} className="block w-full rounded-md px-2 py-1 text-left text-xs text-slate-300 hover:bg-white/5">
                    <span className="mr-1.5 inline-grid min-w-5 place-items-center rounded-full bg-orange-500 px-1 text-[10px] font-bold text-white">{s.order}</span>
                    {nodeLabel(s.nodeId) ?? <span className="text-slate-500">a step no longer on this draft</span>}
                    {s.assumed && <span className="ml-1 block pl-6 text-[10px] text-amber-300">assumed — the replay can&apos;t know {s.assumed}</span>}
                    {Object.entries(s.changed).map(([k, v]) => <span key={k} className="ml-1 block pl-6 font-mono text-[10px] text-sky-300">{k} = {v.slice(0, 80)}</span>)}
                  </button>
                ))}
                {t.bot.map((m, i) => <p key={i} className="whitespace-pre-wrap rounded-md bg-white/[0.04] px-2 py-1 text-xs text-slate-300"><span className="text-slate-500">Bot: </span>{m}</p>)}
              </div>
            ))}
            {Object.keys(result.finalVars).length > 0 && (
              <div className="rounded-lg border border-white/10 p-2.5">
                <p className="mb-1 text-xs font-semibold text-slate-300">Stored values at the end</p>
                {Object.entries(result.finalVars).map(([k, v]) => <p key={k} className="font-mono text-[10px] text-sky-300">{k} = {v.slice(0, 80)}</p>)}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
