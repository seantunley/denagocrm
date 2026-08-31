"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, Bot, CheckCircle2, CircleStop, Clock3, FileUp, Hand, MessageCircle, Play, RotateCcw, Send, SlidersHorizontal, UserRound } from "lucide-react";
import { simulateFlowTurn } from "@/app/actions/flowSimulator";
import { DEFAULT_SIMULATOR_SCENARIO, type SimulatorScenario } from "@/lib/flowSimulatorScenario";
import WhatsAppPreview, { type PreviewLine } from "@/components/WhatsAppPreview";
import type { FlowSession, OutMsg } from "@/lib/flow";

type ChatLine = { id: string; role: "customer" | "bot"; text: string; time: string; msg?: OutMsg };
type Choice = { id: string; label: string; description?: string };
type RunState = "idle" | "running" | "waiting" | "completed" | "handoff" | "failed";

type ScenarioPreset = { id: string; label: string; description: string; scenario: SimulatorScenario };

const SCENARIO_PRESETS: ScenarioPreset[] = [
  { id: "happy", label: "Happy path", description: "AI, CRM, slots and Journey all succeed.", scenario: DEFAULT_SIMULATOR_SCENARIO },
  { id: "handoff", label: "AI handoff", description: "Force the AI confidence handoff path.", scenario: { ...DEFAULT_SIMULATOR_SCENARIO, ai: "handoff" } },
  { id: "crm-failure", label: "CRM failure", description: "Exercise failure routing for CRM actions.", scenario: { ...DEFAULT_SIMULATOR_SCENARIO, crm: "failure" } },
  { id: "fully-booked", label: "Fully booked", description: "Exercise the no-capacity slot route.", scenario: { ...DEFAULT_SIMULATOR_SCENARIO, slots: "none" } },
];

let lineSeq = 0;
const line = (role: ChatLine["role"], text: string, msg?: OutMsg): ChatLine => ({
  id: `${Date.now()}-${lineSeq++}`,
  role,
  text,
  time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  ...(msg ? { msg } : {}),
});

export default function FlowSimulator({
  flowId,
  businessName,
  draftDefinition,
}: {
  flowId: string;
  draftDefinition?: string;
  businessName: string;
}) {
  const [view, setView] = useState<"whatsapp" | "plain">("whatsapp");
  const [session, setSession] = useState<FlowSession | null>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [trace, setTrace] = useState<string[]>([]);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [runState, setRunState] = useState<RunState>("idle");
  const [scenario, setScenario] = useState<SimulatorScenario>(DEFAULT_SIMULATOR_SCENARIO);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const variableEntries = useMemo(() => Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)), [vars]);

  function resetRun(nextScenario?: SimulatorScenario) {
    if (nextScenario) setScenario(nextScenario);
    setSession(null);
    setChat([]);
    setChoices([]);
    setTrace([]);
    setVars({});
    setText("");
    setError(null);
    setStarted(false);
    setEnded(false);
    setRunState("idle");
  }

  function appendBotMessages(messages: OutMsg[]) {
    const lines: ChatLine[] = [];
    let nextChoices: Choice[] = [];
    for (const message of messages) {
      if (message.type === "text") lines.push(line("bot", message.text, message));
      else if (message.type === "image") lines.push(line("bot", `🖼 ${message.caption || message.url}`, message));
      else {
        lines.push(line("bot", message.text, message));
        nextChoices = message.options;
      }
    }
    setChat((current) => [...current, ...lines]);
    setChoices(nextChoices);
  }

  function runTurn(input: { text?: string; choiceId?: string; fileUrl?: string }, customerLabel?: string) {
    setRunState("running");
    startTransition(async () => {
      setError(null);
      if (customerLabel) setChat((current) => [...current, line("customer", customerLabel)]);
      const result = await simulateFlowTurn({ flowId, draftDefinition, session, ...input, scenario });
      if (!result.ok) {
        setError(result.error ?? "Simulation failed.");
        setTrace((current) => [...current, ...result.trace]);
        setRunState("failed");
        return;
      }
      setSession(result.session);
      setVars(result.vars);
      setTrace((current) => [...current, ...result.trace]);
      appendBotMessages(result.messages);
      const stopped = result.handedOff || !result.session;
      setEnded(stopped);
      setStarted(true);
      setRunState(result.handedOff ? "handoff" : !result.session ? "completed" : "waiting");
    });
  }

  function start() {
    setSession(null);
    setChat([]);
    setChoices([]);
    setTrace([]);
    setVars({});
    setError(null);
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
    runTurn({ text: "[simulated file]", fileUrl: "https://simulator.invalid/sample-file.jpg" }, "📎 sample-file.jpg");
  }

  function changeScenario<K extends keyof SimulatorScenario>(key: K, value: SimulatorScenario[K]) {
    resetRun({ ...scenario, [key]: value });
  }

  return (
    <div className="grid min-h-[680px] gap-4 xl:flex">
      <section className="flex min-h-[620px] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f1412]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-white"><Bot className="size-4 text-primary" />Customer preview</p>
            <p className="text-xs text-slate-400">Draft only · CRM writes and provider sends are disabled</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RunStatePill state={runState} />
            <div className="flex overflow-hidden rounded-lg border border-white/10">
              <button type="button" onClick={() => setView("whatsapp")} className={`flex min-h-9 items-center gap-1.5 px-2.5 py-1 text-xs ${view === "whatsapp" ? "bg-white/10 text-white" : "text-slate-400"}`} title="Draw it the way WhatsApp will"><MessageCircle className="size-3.5" /> WhatsApp</button>
              <button type="button" onClick={() => setView("plain")} className={`flex min-h-9 items-center gap-1.5 px-2.5 py-1 text-xs ${view === "plain" ? "bg-white/10 text-white" : "text-slate-400"}`} title="Plain transcript, easiest to read against the trace"><SlidersHorizontal className="size-3.5" /> Plain</button>
            </div>
            <button type="button" onClick={start} disabled={pending} className="btn-secondary btn-sm">
              {started ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />}{started ? "Rerun" : "Start"}
            </button>
          </div>
        </div>

        {view === "whatsapp" && started && (
          <WhatsAppPreview
            lines={chat.flatMap<PreviewLine>((entry) => entry.role === "customer" ? [{ id: entry.id, role: "customer", text: entry.text }] : entry.msg ? [{ id: entry.id, role: "bot", msg: entry.msg }] : [])}
            onPick={(id) => { const picked = choices.find((choice) => choice.id === id); if (picked) choose(picked); }}
            disabled={pending || ended}
            businessName={businessName}
          />
        )}

        <div className={`flex-1 space-y-3 overflow-y-auto p-4 ${view === "whatsapp" && started ? "hidden" : ""}`}>
          {!started && (
            <div className="grid h-full min-h-80 place-items-center text-center">
              <div><Bot className="mx-auto mb-3 size-8 text-slate-500" /><p className="text-sm text-slate-300">Start the simulator to run the current draft.</p><p className="mt-1 text-xs text-slate-500">Nothing here is sent to customers or written into the CRM.</p></div>
            </div>
          )}
          {chat.map((entry) => (
            <div key={entry.id} className={`flex ${entry.role === "customer" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm leading-5 ${entry.role === "customer" ? "bg-primary text-primary-foreground" : "border border-white/10 bg-white/[0.045] text-slate-100"}`}>
                <div className="mb-1 flex items-center gap-1.5 text-[10px] opacity-60">{entry.role === "customer" ? <UserRound className="size-3" /> : <Bot className="size-3" />}{entry.role === "customer" ? "Customer" : "Bot"}<span>·</span><Clock3 className="size-2.5" />{entry.time}</div>
                <span className="whitespace-pre-wrap">{entry.text}</span>
              </div>
            </div>
          ))}
        </div>

        {(pending || error || (ended && started)) && (
          <div className="space-y-2 px-4 pb-3">
            {pending && <p className="text-xs text-slate-500">Running draft…</p>}
            {error && <p className="rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2 text-xs text-red-300">{error}</p>}
            {ended && started && !pending && !error && <p className="text-center text-xs text-slate-500">Simulation stopped · rerun to test again.</p>}
          </div>
        )}

        <div className="border-t border-white/10 p-3">
          {choices.length > 0 && !ended && view === "plain" && (
            <div className="mb-3 flex flex-wrap gap-2">
              {choices.map((choice) => <button key={choice.id} type="button" disabled={pending} onClick={() => choose(choice)} className="btn-secondary btn-sm text-left"><span>{choice.label}</span>{choice.description ? <span className="text-[10px] text-slate-500"> · {choice.description}</span> : null}</button>)}
            </div>
          )}
          <div className="flex gap-2">
            <input className="input flex-1" value={text} disabled={!started || pending || ended} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitText(); } }} placeholder={ended ? "Simulation ended" : "Type the customer's reply…"} />
            <button type="button" onClick={attachSample} disabled={!started || pending || ended} className="btn-secondary btn-sm" title="Simulate a file upload"><FileUp className="size-4" /></button>
            <button type="button" onClick={submitText} disabled={!started || pending || ended || !text.trim()} className="btn-primary btn-sm"><Send className="size-4" />Send</button>
          </div>
        </div>
      </section>

      <aside className="space-y-4 xl:w-[22rem] xl:min-w-[18rem] xl:max-w-[32rem] xl:resize-x xl:overflow-auto">
        <section className="rounded-2xl border border-orange-400/20 bg-orange-500/[0.04] p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-orange-200">Scenario presets</p>
          <p className="mt-1 text-[11px] leading-5 text-slate-400">Choose a QA path, then adjust individual conditions below.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {SCENARIO_PRESETS.map((preset) => {
              const active = JSON.stringify(scenario) === JSON.stringify(preset.scenario);
              return <button key={preset.id} type="button" onClick={() => resetRun(preset.scenario)} className={`rounded-xl border p-2.5 text-left transition ${active ? "border-orange-400/45 bg-orange-400/10" : "border-white/10 bg-white/[0.025] hover:bg-white/[0.05]"}`}><span className="block text-xs font-semibold text-slate-100">{preset.label}</span><span className="mt-1 block text-[10px] leading-4 text-slate-500">{preset.description}</span></button>;
            })}
          </div>
          <div className="mt-4 grid gap-3 border-t border-white/10 pt-4">
            <ScenarioSelect label="AI outcome" value={scenario.ai} onChange={(value) => changeScenario("ai", value as SimulatorScenario["ai"])} options={[["answer", "Answers"], ["handoff", "Hands off"], ["timeout", "Times out"]]} />
            <ScenarioSelect label="CRM actions" value={scenario.crm} onChange={(value) => changeScenario("crm", value as SimulatorScenario["crm"])} options={[["success", "Succeed"], ["failure", "Fail"]]} />
            <ScenarioSelect label="Workshop slots" value={scenario.slots} onChange={(value) => changeScenario("slots", value as SimulatorScenario["slots"])} options={[["available", "Available"], ["none", "Fully booked"], ["race_lost", "Taken before booking"]]} />
            <ScenarioSelect label="Customer identity" value={scenario.bookingIdentity} onChange={(value) => changeScenario("bookingIdentity", value as SimulatorScenario["bookingIdentity"])} options={[["verified", "Verified"], ["unverified", "Unverified"]]} />
            <ScenarioSelect label="Booking lookup" value={scenario.bookingLookup} onChange={(value) => changeScenario("bookingLookup", value as SimulatorScenario["bookingLookup"])} options={[["found", "Booking found"], ["missing", "No booking"]]} />
            <ScenarioSelect label="Journey enrolment" value={scenario.journey} onChange={(value) => changeScenario("journey", value as SimulatorScenario["journey"])} options={[["success", "Succeeds"], ["failure", "Fails"]]} />
          </div>
        </section>
        <section className="rounded-2xl border border-white/10 bg-[#111614] p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Execution trace</p>
          <div className="mt-3 max-h-80 space-y-1.5 overflow-y-auto font-mono text-[11px] leading-5 text-slate-400">{trace.length ? trace.map((entry, index) => <p key={`${index}-${entry}`}><span className="mr-1 text-slate-600">{String(index + 1).padStart(2, "0")}</span>{entry}</p>) : <p>No turns yet.</p>}</div>
        </section>
        <section className="rounded-2xl border border-white/10 bg-[#111614] p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Variables</p>
          <div className="mt-3 space-y-2 text-xs">{variableEntries.length ? variableEntries.map(([key, value]) => <div key={key} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2"><code className="text-orange-300">{`{{${key}}}`}</code><span className="break-all text-slate-300">{value || "—"}</span></div>) : <p className="text-slate-500">No captured variables yet.</p>}</div>
        </section>
      </aside>
    </div>
  );
}

function RunStatePill({ state }: { state: RunState }) {
  const meta: Record<RunState, { label: string; className: string; icon: typeof Clock3 }> = {
    idle: { label: "Not run", className: "border-white/10 text-slate-400", icon: CircleStop },
    running: { label: "Running", className: "border-sky-400/20 bg-sky-400/10 text-sky-200", icon: Clock3 },
    waiting: { label: "Waiting", className: "border-amber-400/20 bg-amber-400/10 text-amber-200", icon: Clock3 },
    completed: { label: "Completed", className: "border-emerald-400/20 bg-emerald-400/10 text-emerald-200", icon: CheckCircle2 },
    handoff: { label: "Handed off", className: "border-orange-400/20 bg-orange-400/10 text-orange-200", icon: Hand },
    failed: { label: "Failed", className: "border-red-400/20 bg-red-400/10 text-red-200", icon: AlertTriangle },
  };
  const current = meta[state];
  const Icon = current.icon;
  return <span className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium ${current.className}`}><Icon className="size-3.5" />{current.label}</span>;
}

function ScenarioSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return (
    <label className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-2 text-xs text-slate-300">
      <span>{label}</span>
      <select className="input btn-sm" value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}</select>
    </label>
  );
}
