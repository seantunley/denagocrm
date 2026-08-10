"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  CalendarDays,
  CircleStop,
  FileQuestion,
  FileUp,
  GitBranch,
  Hand,
  ImageIcon,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  Save,
  Sparkles,
  Upload,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import { saveFlow, resetFlow } from "@/app/actions/flow";
import { uploadCampaignImage } from "@/app/actions/campaigns";
import type { BookingAction, ConditionOperator, FlowNode, SlotAction } from "@/lib/flow";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { cn } from "@/lib/utils";
import { BuilderSaveStatus, BuilderWorkspaceBar, BuilderWorkspaceShell } from "@/components/builder-workspace";

type Pos = { x: number; y: number };
type FlowData = { start: string; nodes: Record<string, FlowNode>; positions?: Record<string, Pos> };
type RFData = { flow: FlowNode; isStart: boolean };
export type FlowJourneyOption = { id: string; name: string };

const BUILTIN_VARIABLES = [
  "greeting", "first_name", "name", "known", "slot", "channel", "current_date", "current_time",
  "booking_identity", "booking_found", "booking_id", "booking_slot", "booking_summary", "booking_cancelled", "booking_rescheduled",
  "journey_started", "journey_reason", "journey_run_id",
];

const TYPE_META: Record<string, { icon: LucideIcon; label: string; tone: string; header: string; handle: string }> = {
  message: { icon: MessageSquare, label: "Message", tone: "border-sky-400/40", header: "bg-sky-500/15 text-sky-200", handle: "#38bdf8" },
  choice: { icon: GitBranch, label: "Menu", tone: "border-violet-400/40", header: "bg-violet-500/15 text-violet-200", handle: "#a78bfa" },
  capture: { icon: FileQuestion, label: "Ask & save", tone: "border-cyan-400/40", header: "bg-cyan-500/15 text-cyan-200", handle: "#22d3ee" },
  captureFile: { icon: FileUp, label: "Get a file", tone: "border-cyan-400/40", header: "bg-cyan-500/15 text-cyan-200", handle: "#22d3ee" },
  image: { icon: ImageIcon, label: "Send image", tone: "border-violet-400/40", header: "bg-violet-500/15 text-violet-200", handle: "#a78bfa" },
  answer: { icon: Sparkles, label: "Answer", tone: "border-blue-400/40", header: "bg-blue-500/15 text-blue-200", handle: "#60a5fa" },
  slots: { icon: CalendarDays, label: "Workshop slots", tone: "border-emerald-400/40", header: "bg-emerald-500/15 text-emerald-200", handle: "#34d399" },
  booking: { icon: Wrench, label: "CRM / booking action", tone: "border-emerald-400/40", header: "bg-emerald-500/15 text-emerald-200", handle: "#34d399" },
  journey: { icon: Workflow, label: "Start Journey", tone: "border-teal-400/40", header: "bg-teal-500/15 text-teal-200", handle: "#2dd4bf" },
  condition: { icon: GitBranch, label: "Condition", tone: "border-fuchsia-400/40", header: "bg-fuchsia-500/15 text-fuchsia-200", handle: "#e879f9" },
  ai: { icon: Bot, label: "AI answer", tone: "border-orange-400/50", header: "bg-orange-500/15 text-orange-200", handle: "#fb923c" },
  handoff: { icon: Hand, label: "Hand off", tone: "border-amber-400/40", header: "bg-amber-500/15 text-amber-100", handle: "#fbbf24" },
  end: { icon: CircleStop, label: "End", tone: "border-slate-500/50", header: "bg-slate-500/15 text-slate-200", handle: "#94a3b8" },
};

function summary(n: FlowNode): string {
  if (n.type === "message" || n.type === "handoff") return n.text?.slice(0, 60) ?? "";
  if (n.type === "capture") return `“${n.text.slice(0, 40)}” → {{${n.variable}}}`;
  if (n.type === "captureFile") return `Ask for a file → {{${n.variable}}}`;
  if (n.type === "image") return n.url ? "Sends an image" : "(no image set)";
  if (n.type === "answer") return n.answerSource ? `Send ${n.answerSource}` : (n.text ?? "").slice(0, 50);
  if (n.type === "slots") return n.action === "reschedule" ? "Moves an existing booking to a real open slot" : "Offers real open workshop slots";
  if (n.type === "booking") {
    if (n.action === "lookup") return "Finds this customer's next service booking";
    if (n.action === "cancel") return "Cancels the customer-owned booking in {{booking_id}}";
    return `Creates a ${n.action ?? "service"} in the CRM`;
  }
  if (n.type === "journey") return n.journeyId ? "Enrols this customer in an asynchronous Journey" : "Choose a Journey";
  if (n.type === "condition") {
    const op = n.condition.operator.replace("_", " ");
    return `{{${n.condition.variable || "variable"}}} ${op}${n.condition.value ? ` “${n.condition.value}”` : ""}`;
  }
  if (n.type === "ai") return "Chats, grounded in your prices & brief";
  if (n.type === "choice") return n.text.slice(0, 50);
  return "";
}

function NodeCard({ data }: NodeProps) {
  const d = data as unknown as RFData;
  const n = d.flow;
  const meta = TYPE_META[n.type];
  const Icon = meta.icon;
  return (
    <div className={cn("w-56 rounded-xl border bg-slate-950/95 text-slate-100 shadow-xl", d.isStart ? "border-orange-400/70 ring-2 ring-orange-400/15" : meta.tone)}>
      <Handle type="target" position={Position.Left} id="in" style={{ background: "#64748b" }} />
      <div className={cn("flex items-center gap-1.5 rounded-t-[11px] px-3 py-2 text-xs font-semibold", meta.header)}>
        <Icon className="size-3.5" />
        {meta.label}
        {d.isStart && <span className="ml-auto text-[10px] bg-orange-600 px-1.5 rounded">START</span>}
      </div>
      <div className="px-3 py-2 text-xs text-slate-300 min-h-8 whitespace-pre-wrap">{summary(n) || "…"}</div>

      {n.type === "choice" ? (
        <div className="pb-1">
          {n.options.map((o, i) => (
            <div key={o.id} className="relative px-3 py-1 text-[11px] text-slate-400 border-t border-slate-800">
              {o.label}
              <Handle type="source" position={Position.Right} id={`opt:${o.id}`} style={{ top: `${100 + i * 26}px`, background: meta.handle }} />
            </div>
          ))}
        </div>
      ) : n.type === "condition" ? (
        <div className="pb-1">
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-emerald-300">Yes
            <Handle type="source" position={Position.Right} id="true" style={{ top: "92px", background: "#34d399" }} />
          </div>
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-red-300">No
            <Handle type="source" position={Position.Right} id="false" style={{ top: "118px", background: "#f87171" }} />
          </div>
        </div>
      ) : n.type === "ai" ? (
        <Handle type="source" position={Position.Right} id="handoff" style={{ background: meta.handle }} />
      ) : n.type === "handoff" || n.type === "end" ? null : (
        <Handle type="source" position={Position.Right} id="out" style={{ background: meta.handle }} />
      )}
    </div>
  );
}

const nodeTypes = { flowNode: NodeCard };

let seq = 0;
const newId = (type: string) => `${type}_${Date.now().toString(36)}${seq++}`;

function blankNode(type: FlowNode["type"], id: string): FlowNode {
  switch (type) {
    case "message": return { id, type, text: "Your message…" };
    case "choice": return { id, type, text: "Pick an option:", options: [{ id: "o1", label: "Option 1" }, { id: "o2", label: "Option 2" }] };
    case "capture": return { id, type, text: "What's your name?", variable: "name" };
    case "captureFile": return { id, type, text: "Please send a photo", variable: "photo" };
    case "image": return { id, type, url: "" };
    case "answer": return { id, type, answerSource: "pricelist" };
    case "slots": return { id, type, action: "book", text: "Here are our next open times — pick one:", noneText: "We're fully booked online — the team will call you." };
    case "booking": return { id, type, action: "service", text: "Thanks — the team will confirm shortly." };
    case "journey": return { id, type, journeyId: "", text: "You're all set — we'll keep you updated." };
    case "condition": return { id, type, condition: { variable: "channel", operator: "equals", value: "whatsapp" } };
    case "ai": return { id, type };
    case "handoff": return { id, type, text: "Let me get a team member to help — one moment." };
    default: return { id, type: "end" };
  }
}

export default function FlowBuilder({ flowId, initial, journeys = [], updatedAt }: { flowId: string; initial: FlowData; journeys?: FlowJourneyOption[]; updatedAt: string }) {
  const router = useRouter();
  const [start, setStart] = useState(initial.start);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<RFData>>(
    Object.values(initial.nodes).map((n, i) => ({
      id: n.id,
      type: "flowNode",
      position: initial.positions?.[n.id] ?? { x: (i % 4) * 300 + 40, y: Math.floor(i / 4) * 220 + 40 },
      data: { flow: n, isStart: n.id === initial.start },
    }))
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState("Saved");
  // The draft stamp this canvas is working from. Every save is fenced against it,
  // and a successful save adopts the new one.
  const savedAt = useRef<string>(updatedAt);
  // Leaving with unsaved work loses it silently. The canvas already tracks the
  // state; it just never told the browser.
  //
  // Scope: beforeunload fires on a document unload, so this catches closing the
  // tab and navigating away from the app — not in-app <Link> navigation, which
  // never unloads. That is the larger share of accidental loss; a router-level
  // guard for the rest is worth doing properly rather than half-doing here.
  useEffect(() => {
    if (status === "Saved") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);
  const [fullscreen, setFullscreen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const patch = useCallback((id: string, updater: (n: FlowNode) => FlowNode) => {
    setStatus("Unsaved changes");
    setRfNodes((ns) => ns.map((rn) => (rn.id === id ? { ...rn, data: { ...rn.data, flow: updater(rn.data.flow) } } : rn)));
  }, [setRfNodes]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const rn of rfNodes) {
      const n = rn.data.flow;
      const add = (handle: string, target?: string) => {
        if (target && rfNodes.some((x) => x.id === target)) out.push({ id: `${n.id}:${handle}`, source: n.id, sourceHandle: handle, target, animated: true, style: { stroke: "#475569" } });
      };
      if (n.type === "choice") n.options.forEach((o) => add(`opt:${o.id}`, o.next));
      else if (n.type === "condition") { add("true", n.trueNext); add("false", n.falseNext); }
      else if (n.type === "ai") add("handoff", n.handoffNext);
      else if (n.type !== "handoff" && n.type !== "end") add("out", (n as { next?: string }).next);
    }
    return out;
  }, [rfNodes]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle) return;
    patch(c.source, (n) => {
      if (n.type === "choice" && c.sourceHandle!.startsWith("opt:")) {
        const oid = c.sourceHandle!.slice(4);
        return { ...n, options: n.options.map((o) => (o.id === oid ? { ...o, next: c.target! } : o)) };
      }
      if (n.type === "condition") {
        if (c.sourceHandle === "true") return { ...n, trueNext: c.target! };
        if (c.sourceHandle === "false") return { ...n, falseNext: c.target! };
      }
      if (n.type === "ai" && c.sourceHandle === "handoff") return { ...n, handoffNext: c.target! };
      return { ...n, next: c.target! } as FlowNode;
    });
  }, [patch]);

  function addNode(type: FlowNode["type"]) {
    const id = newId(type);
    setRfNodes((ns) => [...ns, { id, type: "flowNode", position: { x: 120 + Math.random() * 200, y: 120 + Math.random() * 200 }, data: { flow: blankNode(type, id), isStart: false } }]);
    setSelectedId(id);
    setStatus("Unsaved changes");
    setInspectorOpen(true);
  }

  function removeNode(id: string) {
    setRfNodes((ns) => ns.filter((n) => n.id !== id).map((n) => ({ ...n, data: { ...n.data, flow: clearRefs(n.data.flow, id) } })));
    if (selectedId === id) setSelectedId(null);
    setStatus("Unsaved changes");
  }

  function markStart(id: string) {
    setStart(id);
    setRfNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, isStart: n.id === id } })));
    setStatus("Unsaved changes");
  }

  async function onSave() {
    setStatus("Saving…");
    const nodes: Record<string, FlowNode> = {};
    const positions: Record<string, Pos> = {};
    for (const rn of rfNodes) {
      nodes[rn.id] = rn.data.flow;
      positions[rn.id] = rn.position;
    }
    const res = await saveFlow(flowId, JSON.stringify({ start, nodes, positions }), savedAt.current);
    if (res.ok) {
      savedAt.current = res.updatedAt ?? savedAt.current;
      setStatus("Saved");
    } else {
      // A conflict must be loud. Silently keeping "Unsaved changes" would let the
      // owner keep editing a draft the server has already refused.
      setStatus(res.conflict ? "Not saved — this draft changed elsewhere" : res.error ?? "Save failed");
      if (res.error) toast.error(res.error);
    }
    if (res.ok) {
      toast.success("Flow saved");
      router.refresh();
    } else toast.error(res.error ?? "Flow could not be saved");
  }

  const selected = rfNodes.find((n) => n.id === selectedId)?.data.flow ?? null;
  const nodeOptions = rfNodes.map((n) => ({ id: n.id, label: `${TYPE_META[n.data.flow.type].label}: ${summary(n.data.flow).slice(0, 24) || n.data.flow.type}` }));
  const knownVariables = useMemo(() => {
    const vars = new Set(BUILTIN_VARIABLES);
    for (const rn of rfNodes) {
      const node = rn.data.flow;
      if (node.type === "capture" || node.type === "captureFile") if (node.variable) vars.add(node.variable);
    }
    return [...vars].sort();
  }, [rfNodes]);

  return (
    <BuilderWorkspaceShell fullscreen={fullscreen} className="min-h-[720px] md:h-[calc(100dvh-8rem)] md:min-h-0">
      <BuilderWorkspaceBar title="Conversation flow" description="Connect nodes to shape customer conversations and CRM hand-offs." status={<BuilderSaveStatus status={status} />}>
        <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.035] p-0.5">
          <button type="button" onClick={() => setPaletteOpen((value) => !value)} className={cn("flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-slate-300 hover:bg-white/7", paletteOpen && "bg-primary/15 text-primary")}>
            {paletteOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />} Nodes
          </button>
          <button type="button" onClick={() => setInspectorOpen((value) => !value)} className={cn("flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-slate-300 hover:bg-white/7", inspectorOpen && "bg-primary/15 text-primary")}>
            {inspectorOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />} Inspector
          </button>
        </div>
        <button type="button" onClick={onSave} className="btn-primary btn-sm"><Save className="size-4" />Save</button>
        <ConfirmActionDialog destructive title="Reset this flow?" description="Every node, connection and unsaved change will be replaced with the default flow." confirmLabel="Reset flow" onConfirm={async () => { await resetFlow(flowId, savedAt.current); toast.success("Flow reset"); router.refresh(); }} trigger={<button type="button" className="btn-secondary btn-sm"><RotateCcwIcon />Reset</button>} />
        <button type="button" onClick={() => setFullscreen((value) => !value)} className="btn-secondary btn-sm" title={fullscreen ? "Exit full screen" : "Full screen"}>
          {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}<span className="hidden sm:inline">{fullscreen ? "Exit" : "Full screen"}</span>
        </button>
      </BuilderWorkspaceBar>

      <div className="relative flex min-h-0 flex-1">
        {paletteOpen && (
          <aside className="w-60 shrink-0 overflow-y-auto border-r border-white/[0.08] bg-[#111614] max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-[80] max-md:max-h-[72dvh] max-md:w-auto max-md:rounded-t-3xl max-md:border-t max-md:shadow-[0_-24px_70px_rgba(0,0,0,.55)]">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.08] bg-[#111614]/95 px-4 py-3 backdrop-blur"><div><p className="text-sm font-semibold text-white">Node palette</p><p className="text-xs text-slate-400">Add a step to the canvas</p></div><button type="button" onClick={() => setPaletteOpen(false)} className="grid size-8 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-4" /><span className="sr-only">Close node palette</span></button></div>
            <div className="grid gap-2 p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">
              {(Object.keys(TYPE_META) as FlowNode["type"][]).map((type) => {
                const meta = TYPE_META[type];
                const Icon = meta.icon;
                return <button key={type} type="button" onClick={() => addNode(type)} className={cn("flex items-center gap-3 rounded-xl border bg-white/[0.025] px-3 py-2.5 text-left text-sm text-slate-200 transition hover:bg-white/[0.055]", meta.tone)}><span className={cn("grid size-8 place-items-center rounded-lg", meta.header)}><Icon className="size-4" /></span><span>{meta.label}</span></button>;
              })}
            </div>
          </aside>
        )}

        <main className="min-w-0 flex-1 bg-[#0b0f0e] p-2 sm:p-3">
          <div className="h-full min-h-[32rem] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0f1412]">
            <ReactFlow nodes={rfNodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onConnect={onConnect} onNodeClick={(_, node) => { setSelectedId(node.id); setInspectorOpen(true); }} onPaneClick={() => setSelectedId(null)} fitView proOptions={{ hideAttribution: true }}>
              <Background color="#25312d" gap={20} />
              <Controls className="!border-white/10 !bg-[#18201d] !text-white" />
            </ReactFlow>
          </div>
        </main>

        {inspectorOpen && (
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-white/[0.08] bg-[#111614] max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-[81] max-md:max-h-[78dvh] max-md:w-auto max-md:rounded-t-3xl max-md:border-t max-md:shadow-[0_-24px_70px_rgba(0,0,0,.55)]">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.08] bg-[#111614]/95 px-4 py-3 backdrop-blur"><div><p className="text-sm font-semibold text-white">Inspector</p><p className="text-xs text-slate-400">Configure the selected node</p></div><button type="button" onClick={() => setInspectorOpen(false)} className="grid size-8 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-4" /><span className="sr-only">Close inspector</span></button></div>
            <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-5">
              {!selected ? <p className="text-sm leading-6 text-slate-400">Select a node to edit it. Drag from a node&apos;s output handle to another node to create a connection.</p> : <NodePanel key={selected.id} node={selected} isStart={selected.id === start} nodeOptions={nodeOptions.filter((option) => option.id !== selected.id)} variables={knownVariables} journeys={journeys} onChange={(next) => patch(selected.id, () => next)} onDelete={() => removeNode(selected.id)} onMakeStart={() => markStart(selected.id)} />}
              <VariablesPanel variables={knownVariables} />
            </div>
          </aside>
        )}
      </div>
    </BuilderWorkspaceShell>
  );
}

function RotateCcwIcon() { return <RotateCcw className="size-4" />; }

function clearRefs(n: FlowNode, removedId: string): FlowNode {
  if (n.type === "choice") return { ...n, options: n.options.map((o) => (o.next === removedId ? { ...o, next: undefined } : o)) };
  if (n.type === "condition") return { ...n, trueNext: n.trueNext === removedId ? undefined : n.trueNext, falseNext: n.falseNext === removedId ? undefined : n.falseNext };
  if (n.type === "ai") return n.handoffNext === removedId ? { ...n, handoffNext: undefined } : n;
  // Deleting a node has to clear EVERY edge pointing at it, not just `next`.
  // A dangling failureNext/unavailableNext would now be a publish error the
  // operator did not create and cannot see on the canvas.
  const routed = n as { next?: string; failureNext?: string; unavailableNext?: string };
  const cleared: Record<string, undefined> = {};
  if (routed.next === removedId) cleared.next = undefined;
  if (routed.failureNext === removedId) cleared.failureNext = undefined;
  if (routed.unavailableNext === removedId) cleared.unavailableNext = undefined;
  return Object.keys(cleared).length ? ({ ...n, ...cleared } as FlowNode) : n;
}

/** Node types whose action can fail, and therefore need their own outcome routes. */
const FALLIBLE = new Set(["booking", "slots", "journey"]);

function TargetPicker({ value, onPick, nodeOptions }: { value?: string; onPick: (value?: string) => void; nodeOptions: { id: string; label: string }[] }) {
  return <select className="input btn-sm" value={value ?? ""} onChange={(event) => onPick(event.target.value || undefined)}><option value="">— (ends here) —</option>{nodeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>;
}

function VariablesPanel({ variables }: { variables: string[] }) {
  return (
    <div className="border-t border-white/8 pt-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Variables</p>
      <p className="mt-1 text-xs text-slate-500">Use these in messages as <code>{"{{variable}}"}</code> or in a Condition node.</p>
      <div className="mt-2 flex flex-wrap gap-1.5">{variables.map((variable) => <code key={variable} className="rounded-md border border-white/8 bg-white/[0.035] px-1.5 py-1 text-[11px] text-slate-300">{`{{${variable}}}`}</code>)}</div>
    </div>
  );
}

function NodePanel({ node, isStart, nodeOptions, variables, journeys, onChange, onDelete, onMakeStart }: { node: FlowNode; isStart: boolean; nodeOptions: { id: string; label: string }[]; variables: string[]; journeys: FlowJourneyOption[]; onChange: (n: FlowNode) => void; onDelete: () => void; onMakeStart: () => void }) {
  const meta = TYPE_META[node.type];
  const Icon = meta.icon;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4 text-primary" />{meta.label}</span>{!isStart && <button onClick={onMakeStart} className="text-xs text-orange-400 hover:underline">Set as start</button>}</div>

      {(node.type === "message" || node.type === "handoff") && <div><label className="label">Message</label><textarea className="input" rows={4} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div>}

      {node.type === "capture" && <><div><label className="label">Question to ask</label><textarea className="input" rows={3} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div><div className="grid grid-cols-2 gap-2"><div><label className="label">Save as</label><input className="input" value={node.variable} onChange={(e) => onChange({ ...node, variable: e.target.value.replace(/\W/g, "") })} placeholder="name" /></div><div><label className="label">Type</label><select className="input" value={node.format ?? "text"} onChange={(e) => onChange({ ...node, format: e.target.value === "text" ? undefined : (e.target.value as "email" | "phone" | "number" | "date") })}><option value="text">Text</option><option value="email">Email</option><option value="phone">Phone</option><option value="number">Number</option><option value="date">Date</option></select></div></div><p className="text-xs text-slate-500">Use it later as <code>{`{{${node.variable || "name"}}}`}</code>. Name / phone / email feed the CRM action &amp; booking.</p></>}

      {node.type === "captureFile" && <><div><label className="label">What to ask for</label><textarea className="input" rows={2} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} placeholder="Please send a photo of the cart" /></div><div><label className="label">Save file as</label><input className="input" value={node.variable} onChange={(e) => onChange({ ...node, variable: e.target.value.replace(/\W/g, "") })} placeholder="photo" /><p className="text-xs text-slate-500 mt-1">The uploaded file is saved and linked on the lead/booking.</p></div></>}

      {node.type === "image" && <><div><label className="label">Image</label><input className="input" value={node.url} onChange={(e) => onChange({ ...node, url: e.target.value })} placeholder="Paste an image URL, or upload →" /><label className="btn-secondary btn-sm mt-1.5 inline-flex cursor-pointer"><Upload className="size-3.5" /> Upload<input type="file" accept="image/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; const fd = new FormData(); fd.set("file", f); const url = await uploadCampaignImage(fd); if (url) onChange({ ...node, url }); }} /></label></div>{node.url && <img src={node.url} alt="" className="max-h-32 rounded-lg border border-slate-800" />}<div><label className="label">Caption (optional)</label><input className="input" value={node.caption ?? ""} onChange={(e) => onChange({ ...node, caption: e.target.value })} /></div></>}

      {node.type === "slots" && <><div><label className="label">Slot action</label><select className="input" value={node.action ?? "book"} onChange={(e) => onChange({ ...node, action: e.target.value as SlotAction })}><option value="book">Book a new service slot</option><option value="reschedule">Move {"{{booking_id}}"} to a new slot</option></select></div><div><label className="label">Prompt</label><textarea className="input" rows={2} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div><div><label className="label">If nothing&apos;s open</label><textarea className="input" rows={2} value={node.noneText ?? ""} onChange={(e) => onChange({ ...node, noneText: e.target.value })} /></div><p className="text-xs text-slate-500">{node.action === "reschedule" ? <>Atomically moves the existing customer-owned booking in <code>{"{{booking_id}}"}</code>. Put a Booking lookup node first.</> : <>Shows real open workshop slots and reserves the chosen one. The time lands in <code>{"{{slot}}"}</code>.</>}</p></>}

      {node.type === "answer" && <><div><label className="label">Answer type</label><select className="input" value={node.answerSource ?? "static"} onChange={(e) => { const v = e.target.value; onChange(v === "static" ? { ...node, answerSource: undefined, text: node.text ?? "" } : { ...node, answerSource: v as "pricelist" | "colours", text: undefined }); }}><option value="static">Custom text</option><option value="pricelist">Price list (from products)</option><option value="colours">Colours (from products)</option></select></div>{!node.answerSource && <div><label className="label">Text</label><textarea className="input" rows={4} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div>}</>}

      {node.type === "condition" && <><div><label className="label">Variable</label><input className="input" list={`flow-vars-${node.id}`} value={node.condition.variable} onChange={(e) => onChange({ ...node, condition: { ...node.condition, variable: e.target.value.replace(/\W/g, "") } })} placeholder="model" /><datalist id={`flow-vars-${node.id}`}>{variables.map((variable) => <option key={variable} value={variable} />)}</datalist></div><div><label className="label">Rule</label><select className="input" value={node.condition.operator} onChange={(e) => onChange({ ...node, condition: { ...node.condition, operator: e.target.value as ConditionOperator } })}><option value="equals">Equals</option><option value="not_equals">Does not equal</option><option value="contains">Contains</option><option value="exists">Has a value</option><option value="empty">Is empty</option></select></div>{!["exists", "empty"].includes(node.condition.operator) && <div><label className="label">Value</label><input className="input" value={node.condition.value ?? ""} onChange={(e) => onChange({ ...node, condition: { ...node.condition, value: e.target.value } })} placeholder="Rover XL" /></div>}<div className="grid grid-cols-2 gap-2"><div><label className="label text-emerald-300">Yes →</label><TargetPicker nodeOptions={nodeOptions} value={node.trueNext} onPick={(v) => onChange({ ...node, trueNext: v })} /></div><div><label className="label text-red-300">No →</label><TargetPicker nodeOptions={nodeOptions} value={node.falseNext} onPick={(v) => onChange({ ...node, falseNext: v })} /></div></div><p className="text-xs text-slate-500">Conditions are deterministic and never call AI. Text comparisons are case-insensitive.</p></>}

      {node.type === "ai" && <p className="text-xs text-slate-400">Chats conversationally, grounded in approved CRM/product facts and Approved Knowledge. Connect the amber dot to a node to control where it goes when confidence requires a handoff (otherwise it notifies the team).</p>}

      {node.type === "booking" && <><div><label className="label">Action</label><select className="input" value={node.action ?? "service"} onChange={(e) => onChange({ ...node, action: e.target.value as BookingAction })}><option value="service">Create service request</option><option value="demo">Create demo / test-drive lead</option><option value="lead">Create lead / enquiry</option><option value="lookup">Find customer&apos;s next service booking</option><option value="cancel">Cancel {"{{booking_id}}"}</option></select><p className="text-xs text-slate-500 mt-1">{node.action === "lookup" ? <>Read-only. Sets <code>{"{{booking_identity}}"}</code> (verified | unverified) and <code>{"{{booking_found}}"}</code>, <code>{"{{booking_id}}"}</code>, <code>{"{{booking_slot}}"}</code> and <code>{"{{booking_summary}}"}</code> from an existing customer record.</> : node.action === "cancel" ? <>Cancels only the future customer-owned booking in <code>{"{{booking_id}}"}</code> and retains its Activity history.</> : <>Built from captured fields (name, phone, email, service, model). For a real dated service booking use Workshop slots.</>}</p></div><div><label className="label">Message after action (optional)</label><textarea className="input" rows={3} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div></>}

      {node.type === "journey" && <><div><label className="label">Journey</label><select className="input" value={node.journeyId} onChange={(e) => onChange({ ...node, journeyId: e.target.value })}><option value="">Select an active Journey…</option>{journeys.map((journey) => <option key={journey.id} value={journey.id}>{journey.name}</option>)}</select><p className="text-xs text-slate-500 mt-1">Enrols exactly this existing CRM customer/lead in the selected active Journey. Flow continues immediately; waits and later lifecycle actions stay in Journey. Retries reuse the same event identity.</p></div><div><label className="label">Message after enrolment (optional)</label><textarea className="input" rows={3} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div></>}

      {node.type === "choice" && <div className="space-y-2"><div><label className="label">Prompt</label><textarea className="input" rows={2} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div><label className="label">Options</label>{node.options.map((o, i) => <div key={o.id} className="rounded-lg border border-slate-800 p-2 space-y-1.5"><div className="flex gap-1.5"><input className="input btn-sm flex-1" value={o.label} onChange={(e) => onChange({ ...node, options: node.options.map((x) => x.id === o.id ? { ...x, label: e.target.value } : x) })} /><button onClick={() => onChange({ ...node, options: node.options.filter((x) => x.id !== o.id) })} className="px-1 text-muted-foreground hover:text-red-400"><X className="size-4" /><span className="sr-only">Remove option</span></button></div><TargetPicker nodeOptions={nodeOptions} value={o.next} onPick={(v) => onChange({ ...node, options: node.options.map((x) => x.id === o.id ? { ...x, next: v } : x) })} />{i === 2 && node.options.length > 3 && <p className="text-[10px] text-amber-400">WhatsApp shows &gt;3 options as a list.</p>}</div>)}<button onClick={() => onChange({ ...node, options: [...node.options, { id: `o${Date.now().toString(36)}`, label: `Option ${node.options.length + 1}` }] })} className="btn-secondary btn-sm w-full">+ Add option</button></div>}

      {(node.type === "message" || node.type === "answer" || node.type === "capture" || node.type === "captureFile" || node.type === "image" || node.type === "booking" || node.type === "slots" || node.type === "journey") && <div><label className="label">Then go to</label><TargetPicker nodeOptions={nodeOptions} value={(node as { next?: string }).next} onPick={(v) => onChange({ ...node, next: v } as FlowNode)} /></div>}
      {FALLIBLE.has(node.type) && (
        <div className="space-y-2 rounded-lg border border-amber-900/40 bg-amber-950/20 p-2">
          <p className="text-[11px] text-amber-300">
            This action can fail. Publishing is refused if a failure would continue into a node that
            tells the customer it worked.
          </p>
          <div>
            <label className="label">If it fails, say (optional)</label>
            <textarea
              className="input"
              rows={2}
              placeholder="I couldn't do that just yet — a person will pick it up."
              value={(node as { failureText?: string }).failureText ?? ""}
              onChange={(e) => onChange({ ...node, failureText: e.target.value || undefined } as FlowNode)}
            />
          </div>
          <div>
            <label className="label">If it fails, go to</label>
            <TargetPicker nodeOptions={nodeOptions} value={(node as { failureNext?: string }).failureNext} onPick={(v) => onChange({ ...node, failureNext: v } as FlowNode)} />
          </div>
          {node.type === "slots" && (
            <div>
              <label className="label">If nothing is available, go to</label>
              <TargetPicker nodeOptions={nodeOptions} value={(node as { unavailableNext?: string }).unavailableNext} onPick={(v) => onChange({ ...node, unavailableNext: v } as FlowNode)} />
              <p className="text-[10px] text-muted-foreground mt-1">
                Different from a failure: the request was fine, there is just no capacity right now.
              </p>
            </div>
          )}
        </div>
      )}
      {node.type === "ai" && <div><label className="label">On hand-off, go to</label><TargetPicker nodeOptions={nodeOptions} value={node.handoffNext} onPick={(v) => onChange({ ...node, handoffNext: v })} /></div>}

      {!isStart && <button onClick={onDelete} className="btn-danger btn-sm w-full">Delete node</button>}
    </div>
  );
}
