"use client";

import { useMemo, useState, useTransition } from "react";
import { Bot, FileUp, Play, RotateCcw, Send, UserRound } from "lucide-react";
import { simulateFlowTurn } from "@/app/actions/flowSimulator";
import type { FlowSession, OutMsg } from "@/lib/flow";

 type ChatLine = { id: string; role: "customer" | "bot"; text: string };

type Choice = { id: string; label: string; description?: string };

let lineSeq = 0;
const line = (role: ChatLine["role"], text: string): ChatLine => ({ id: `${Date.now()}-${lineSeq++}`, role, text });

export default function FlowSimulator({ flowId }: { flowId: string }) {
  const [session, setSession] = useState<FlowSession | null>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [trace, setTrace] = useState<string[]>([]);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [simulateAiHandoff, setSimulateAiHandoff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const variableEntries = useMemo(() => Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)), [vars]);

  function appendBotMessages(messages: OutMsg[]) {
    const lines: ChatLine[] = [];
    let nextChoices: Choice[] = [];
    for (const message of messages) {
      if (message.type === "text") lines.push(line("bot", message.text));
      else if (message.type === "image") lines.push(line("bot", `🖼 ${message.caption || message.url}`));
      else {
        lines.push(line("bot", message.text));
        nextChoices = message.options;
      }
    }
    setChat((current) => [...current, ...lines]);
    setChoices(nextChoices);
  }

  function runTurn(input: { text?: string; choiceId?: string; fileUrl?: string }, customerLabel?: string) {
    startTransition(async () => {
      setError(null);
      if (customerLabel) setChat((current) => [...current, line("customer", customerLabel)]);
      const result = await simulateFlowTurn({
        flowId,
        session,
        ...input,
        simulateAiHandoff,
      });
      if (!result.ok) {
        setError(result.error ?? "Simulation failed.");
        setTrace((current) => [...current, ...result.trace]);
        return;
      }
      setSession(result.session);
      setVars(result.vars);
      setTrace((current) => [...current, ...result.trace]);
      appendBotMessages(result.messages);
      setEnded(result.handedOff || !result.session);
      setStarted(true);
    });
  }

  function start() {
    setSession(null);
    setChat([]);
    setChoices([]);
    setTrace([]);
    setVars({});
    setEnded(false);
    setStarted(true);
    runTurn({ text: "" });
  }

  function submitText() {
    const value = text.trim();
    if (!value || pending || ended) return;
    setText("");
    setChoices([]);
    runTurn({ text: value }, value);
  }

  function choose(choice: Choice) {
    if (pending || ended) return;
    setChoices([]);
    runTurn({ text: choice.label, choiceId: choice.id }, choice.label);
  }

  function attachSample() {
    if (pending || ended) return;
    setChoices([]);
    runTurn(
      { text: "[simulated file]", fileUrl: "https://simulator.invalid/sample-file.jpg" },
      "📎 sample-file.jpg",
    );
  }

  return (
    <div className="grid min-h-[680px] gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="flex min-h-[620px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f1412]">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-white"><Bot className="size-4 text-primary" />Customer preview</p>
            <p className="text-xs text-slate-400">Draft only · CRM writes and provider sends are disabled</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input type="checkbox" checked={simulateAiHandoff} onChange={(event) => setSimulateAiHandoff(event.target.checked)} />
              AI hands off
            </label>
            <button type="button" onClick={start} disabled={pending} className="btn-secondary btn-sm">
              {started ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />}{started ? "Restart" : "Start"}
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {!started && (
            <div className="grid h-full min-h-80 place-items-center text-center">
              <div><Bot className="mx-auto mb-3 size-8 text-slate-500" /><p className="text-sm text-slate-300">Start the simulator to run the saved draft.</p><p className="mt-1 text-xs text-slate-500">Nothing here is sent to customers or written into the CRM.</p></div>
            </div>
          )}
          {chat.map((entry) => (
            <div key={entry.id} className={`flex ${entry.role === "customer" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm leading-5 ${entry.role === "customer" ? "bg-primary text-primary-foreground" : "border border-white/10 bg-white/[0.045] text-slate-100"}`}>
                <div className="mb-1 flex items-center gap-1 text-[10px] opacity-60">{entry.role === "customer" ? <UserRound className="size-3" /> : <Bot className="size-3" />}{entry.role === "customer" ? "Customer" : "Bot"}</div>
                <span className="whitespace-pre-wrap">{entry.text}</span>
              </div>
            </div>
          ))}
          {pending && <p className="text-xs text-slate-500">Running draft…</p>}
          {error && <p className="rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2 text-xs text-red-300">{error}</p>}
          {ended && started && !pending && <p className="text-center text-xs text-slate-500">Simulation stopped · restart to run again.</p>}
        </div>

        <div className="border-t border-white/10 p-3">
          {choices.length > 0 && !ended && (
            <div className="mb-3 flex flex-wrap gap-2">
              {choices.map((choice) => (
                <button key={choice.id} type="button" disabled={pending} onClick={() => choose(choice)} className="btn-secondary btn-sm text-left">
                  <span>{choice.label}</span>{choice.description ? <span className="text-[10px] text-slate-500"> · {choice.description}</span> : null}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              className="input flex-1"
              value={text}
              disabled={!started || pending || ended}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitText(); } }}
              placeholder={ended ? "Simulation ended" : "Type the customer's reply…"}
            />
            <button type="button" onClick={attachSample} disabled={!started || pending || ended} className="btn-secondary btn-sm" title="Simulate a file upload"><FileUp className="size-4" /></button>
            <button type="button" onClick={submitText} disabled={!started || pending || ended || !text.trim()} className="btn-primary btn-sm"><Send className="size-4" />Send</button>
          </div>
        </div>
      </section>

      <aside className="space-y-4">
        <section className="rounded-2xl border border-white/10 bg-[#111614] p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Execution trace</p>
          <div className="mt-3 max-h-80 space-y-1.5 overflow-y-auto font-mono text-[11px] leading-5 text-slate-400">
            {trace.length ? trace.map((entry, index) => <p key={`${index}-${entry}`}>{index + 1}. {entry}</p>) : <p>No turns yet.</p>}
          </div>
        </section>
        <section className="rounded-2xl border border-white/10 bg-[#111614] p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Variables</p>
          <div className="mt-3 space-y-2 text-xs">
            {variableEntries.length ? variableEntries.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><code className="text-orange-300">{`{{${key}}}`}</code><span className="break-all text-slate-300">{value || "—"}</span></div>
            )) : <p className="text-slate-500">No captured variables yet.</p>}
          </div>
        </section>
      </aside>
    </div>
  );
}
