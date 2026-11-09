"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  BellRing,
  CircleStop,
  CircleX,
  ClipboardList,
  Clock,
  FileQuestion,
  GitBranch,
  Hourglass,
  ListTodo,
  Mail,
  Maximize2,
  MessageSquare,
  Minimize2,
  MousePointer2,
  MoveRight,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PenLine,
  Plus,
  Redo2,
  Repeat,
  RotateCcw,
  Search,
  Split,
  Star,
  Tag,
  Trophy,
  Undo2,
  UserCog,
  Variable,
  Workflow,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { JOURNEY_STEP_LABELS } from "@/lib/journeyTypes";
import { useModuleBlock } from "@/components/journeyModulesContext";
import { newStepId, type BuilderStep } from "@/lib/journeyBuilderDefinition";
import {
  JOURNEY_PALETTE,
  START_NODE,
  addNewStep,
  connectSteps,
  findSteps,
  insertionPoint,
  journeyGraph,
  listAt,
  locate,
  moveStep,
  paletteGroup,
  recordHistory,
  redoHistory,
  removeStep,
  stepSummary,
  undoHistory,
  updateStep,
  type CanvasEdge,
  type CanvasHandle,
  type History,
  type ListRef,
  type PaletteGroup,
} from "@/lib/journeyCanvasGraph";
import { BuilderWorkspaceBar, BuilderWorkspaceShell } from "@/components/builder-workspace";
import { cn } from "@/lib/utils";

/**
 * The Journey as connected cards, with the chatbot builder's chrome (components/FlowBuilder): the Nodes palette, the
 * docked Inspector, Undo/Redo, Find and Full screen. It edits the same steps the list view edits
 * (lib/journeyCanvasGraph explains the wiring). Cards sit where the layout puts them: a saved Journey has no
 * positions, and adding some would change what the builder saves.
 */

const labels: Record<string, string> = JOURNEY_STEP_LABELS;
const handleClass = "!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125";
const HISTORY_GROUP_MS = 700;
const DRAG_TYPE = "application/x-journey-step";

/** One colour per palette group, as FlowBuilder colours its node families. */
const GROUP_LOOK: Record<PaletteGroup | "unknown", { tone: string; header: string; handle: string }> = {
  messages: { tone: "border-sky-400/40", header: "bg-sky-500/15 text-sky-200", handle: "#38bdf8" },
  crm: { tone: "border-emerald-400/40", header: "bg-emerald-500/15 text-emerald-200", handle: "#34d399" },
  timing: { tone: "border-slate-400/50", header: "bg-slate-500/15 text-slate-200", handle: "#94a3b8" },
  logic: { tone: "border-fuchsia-400/40", header: "bg-fuchsia-500/15 text-fuchsia-200", handle: "#e879f9" },
  unknown: { tone: "border-amber-400/60", header: "bg-amber-500/15 text-amber-100", handle: "#fbbf24" },
};

const STEP_META: Record<string, { icon: LucideIcon; description: string }> = {
  send_email: { icon: Mail, description: "Email the customer — a template or your own words" },
  send_sms: { icon: MessageSquare, description: "Text the customer" },
  send_push: { icon: BellRing, description: "Tell the team in the CRM" },
  send_review_request: { icon: Star, description: "Ask for a Google review (at most every 90 days)" },
  send_service_reminder: { icon: Wrench, description: "Remind the customer a service is due" },
  send_signing_reminder: { icon: PenLine, description: "Remind a signer, with their own link" },
  send_survey_reminder: { icon: ClipboardList, description: "Remind the customer to answer a survey" },
  create_activity: { icon: ListTodo, description: "Give someone a call, meeting or to-do" },
  move_stage: { icon: MoveRight, description: "Move the lead to another stage" },
  assign_user: { icon: UserCog, description: "Hand the lead to a salesperson" },
  lead_mark_won: { icon: Trophy, description: "Close an open lead as won" },
  lead_mark_lost: { icon: CircleX, description: "Close an open lead as lost, with a reason" },
  lead_reopen: { icon: RotateCcw, description: "Put a won or lost lead back to open" },
  add_tag: { icon: Tag, description: "Tag the contact" },
  remove_tag: { icon: Tag, description: "Take a tag off the contact" },
  wait: { icon: Clock, description: "Pause for minutes, hours or days" },
  wait_for_trigger: { icon: Zap, description: "Pause until something happens — e.g. a quote is signed" },
  wait_for_condition: { icon: Hourglass, description: "Pause until conditions become true" },
  condition: { icon: GitBranch, description: "Carry on only if the conditions match" },
  choose: { icon: Split, description: "Run the first branch whose conditions match" },
  repeat: { icon: Repeat, description: "Run some steps several times" },
  variables: { icon: Variable, description: "Remember values to use later" },
  stop: { icon: CircleStop, description: "End the journey here" },
};

const lookOf = (type: string) => GROUP_LOOK[paletteGroup(type) ?? "unknown"];

type StepData = { step: BuilderStep; handles: CanvasHandle[] };

/** FlowBuilder's node card: the coloured header with icon and labels, the summary, the outputs. */
function StepCard({ data, selected }: NodeProps<Node<StepData>>) {
  const { step, handles } = data;
  const known = step.type in labels;
  const look = lookOf(step.type);
  const Icon = STEP_META[step.type]?.icon ?? FileQuestion;
  const single = handles.length === 1 && !handles[0].label;
  const off = step.enabled === false;
  const badges = [
    off && { text: "OFF", className: "bg-slate-600", title: "Switched off — runs skip this step" },
    !known && { text: "UNKNOWN", className: "bg-amber-600", title: "This build doesn't know this step type. It is kept exactly as saved." },
    step.continueOnError === true && { text: "KEEPS GOING", className: "bg-sky-700", title: "If this step fails, the journey carries on" },
  ].filter((b): b is { text: string; className: string; title: string } => Boolean(b));
  return (
    <div className={cn(
      "relative w-60 rounded-xl border bg-slate-950/95 text-slate-100 shadow-xl transition-[box-shadow,border-color,transform] duration-150",
      look.tone,
      selected && "ring-2 ring-orange-400/60",
      off && "border-dashed opacity-50",
    )}>
      <Handle type="target" position={Position.Left} id="in" className={handleClass} style={{ background: "#64748b" }} />
      <div className={cn("flex items-center gap-1.5 rounded-t-[11px] px-3 py-2 text-xs font-semibold", look.header)}>
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{known ? labels[step.type] : step.type}</span>
        {badges.map((b, i) => (
          <span key={b.text} className={cn("rounded px-1.5 text-[10px] text-white", b.className, i === 0 && "ml-auto")} title={b.title}>{b.text}</span>
        ))}
      </div>
      <div className="min-h-8 whitespace-pre-wrap px-3 py-2 text-xs leading-5 text-slate-300">{stepSummary(step) || "…"}</div>
      {single ? (
        <Handle type="source" position={Position.Right} id="out" className={handleClass} style={{ background: look.handle }} />
      ) : (
        <div className="pb-1">
          {handles.map((h) => (
            <div key={h.id} className={cn("relative border-t border-slate-800 px-3 py-1 text-[11px]", h.tone === "yes" ? "text-emerald-300" : h.tone === "no" ? "text-red-300" : "text-slate-400")}>
              {h.label}
              <Handle
                type="source"
                position={Position.Right}
                id={h.id}
                className={handleClass}
                style={{ background: h.tone === "yes" ? "#34d399" : h.tone === "no" ? "#f87171" : look.handle }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StartCard() {
  return (
    <div className="relative w-60 rounded-xl border border-orange-400/70 bg-slate-950/95 text-slate-100 shadow-xl ring-2 ring-orange-400/15">
      <div className="flex items-center gap-1.5 rounded-t-[11px] bg-orange-500/15 px-3 py-2 text-xs font-semibold text-orange-200">
        <Workflow className="size-3.5" />Journey starts
        <span className="ml-auto rounded bg-orange-600 px-1.5 text-[10px] text-white">START</span>
      </div>
      <div className="min-h-8 px-3 py-2 text-xs leading-5 text-slate-300">When a trigger enrols someone</div>
      <Handle type="source" position={Position.Right} id="out" className={handleClass} style={{ background: "#fb923c" }} />
    </div>
  );
}

function StopCard({ data }: NodeProps<Node<{ label: string }>>) {
  return (
    <div className="relative flex items-center gap-1.5 rounded-full border border-red-400/40 bg-slate-950/95 px-3 py-1.5 text-[11px] text-red-200">
      <Handle type="target" position={Position.Left} id="in" className={handleClass} style={{ background: "#f87171" }} isConnectable={false} />
      <CircleStop className="size-3.5" />{data.label}
    </div>
  );
}

const nodeTypes = { step: StepCard, start: StartCard, stop: StopCard };

const EDGE_LOOK: Record<CanvasEdge["kind"], { stroke: string; dash?: string; text: string }> = {
  next: { stroke: "#64748b", text: "#cbd5e1" },
  yes: { stroke: "#34d399", text: "#86efac" },
  no: { stroke: "#f87171", dash: "4 4", text: "#fca5a5" },
  branch: { stroke: "#a78bfa", text: "#c4b5fd" },
  rejoin: { stroke: "#475569", dash: "4 4", text: "#94a3b8" },
  loop: { stroke: "#2dd4bf", dash: "4 4", text: "#5eead4" },
};

type CanvasProps = {
  steps: BuilderStep[];
  onChange: (steps: BuilderStep[]) => void;
  /** The list view's own step editors, for the selected step. */
  renderEditor: (step: BuilderStep, depth: number, onStepChange: (step: BuilderStep) => void) => ReactNode;
  /** The journey's Save, shown in the bar only in full screen (where the page's own Save can't be reached). */
  saveButton?: ReactNode;
};

/** The list view's editors for one step. `onStepChange` is only ever called from their event handlers. */
function StepEditor({ render, step, depth, onStepChange }: { render: CanvasProps["renderEditor"]; step: BuilderStep; depth: number; onStepChange: (step: BuilderStep) => void }) {
  return <>{render(step, depth, onStepChange)}</>;
}

export default function JourneyCanvas(props: CanvasProps) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

function Canvas({ steps, onChange, renderEditor, saveButton }: CanvasProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const graph = useMemo(() => journeyGraph(steps), [steps]);
  const stepBlocked = useModuleBlock().step;

  // UNDO / REDO over snapshots of the steps, as FlowBuilder does it: typing into one step's editor is one undo step
  // (edits to the same step within HISTORY_GROUP_MS group), every structural edit is its own.
  const history = useRef<History<BuilderStep[]>>({ past: [], future: [] });
  const historyGroup = useRef<{ key: string; at: number } | null>(null);
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  const syncDepth = () => setHistoryDepth({ undo: history.current.past.length, redo: history.current.future.length });
  const commit = useCallback((next: BuilderStep[], groupKey?: string) => {
    if (next === steps) return;
    const now = Date.now();
    const last = historyGroup.current;
    const grouped = Boolean(groupKey) && last !== null && last.key === groupKey && now - last.at < HISTORY_GROUP_MS;
    historyGroup.current = groupKey ? { key: groupKey, at: now } : null;
    if (!grouped) history.current = recordHistory(history.current, steps);
    setHistoryDepth({ undo: history.current.past.length, redo: history.current.future.length });
    onChange(next);
  }, [steps, onChange]);
  const travel = (move: typeof undoHistory) => {
    const result = move(history.current, steps);
    if (!result) return;
    history.current = result.history;
    historyGroup.current = null;
    syncDepth();
    onChange(result.value);
  };
  const undo = () => travel(undoHistory);
  const redo = () => travel(redoHistory);

  // FIT WHEN THE CARDS CAN BE SEEN (Sean, 2026-11-04: "can't add nodes or anything"). The editor sits in a closed
  // <details>, where cards cannot be measured, so the one-off `fitView` on mount framed nothing and left them as a
  // speck at minimum zoom — and a step added later landed off-screen. Fit each time the cards become measured (the
  // section opened) and whenever a step is added or removed — between 55% (still readable; a longer journey pans,
  // as the chatbot canvas does) and 100%. With a step picked, that card is centred; the Inspector is docked beside
  // the canvas rather than over it, so the centre of the canvas is clear of it.
  const { fitView, getNode, getZoom, setCenter } = useReactFlow();
  const measured = useNodesInitialized();
  const cardCount = graph.nodes.length;
  const show = useCallback((id: string | null) => {
    const node = id ? getNode(id) : undefined;
    if (!node?.measured?.width) { void fitView({ padding: 0.2, minZoom: 0.55, maxZoom: 1, duration: 200 }); return; }
    const zoom = Math.min(Math.max(getZoom(), 0.55), 1);
    void setCenter(node.position.x + node.measured.width / 2, node.position.y + (node.measured.height ?? 0) / 2, { zoom, duration: 200 });
  }, [fitView, getNode, getZoom, setCenter]);
  // Re-run when a side panel opens or closes, or full screen changes: the canvas has a new size, and React Flow only
  // learns it from its resize observer — hence the short wait before centring.
  useEffect(() => {
    if (!measured) return;
    const timer = window.setTimeout(() => show(selectedId), 60);
    return () => window.clearTimeout(timer);
  }, [measured, cardCount, selectedId, show, inspectorOpen, paletteOpen, fullscreen]);

  const nodes: Node[] = useMemo(() => graph.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: { x: n.x, y: n.y },
    selected: n.id === selectedId,
    data: n.kind === "step" ? { step: n.step, handles: n.handles } : n.kind === "stop" ? { label: n.label } : {},
  })), [graph, selectedId]);
  // The canvas must KEEP the sizes React Flow measures (its onNodesChange): without them it believes no card was ever
  // measured — "fit" frames nothing, the minimap is empty, and useNodesInitialized never turns true. A card redrawn
  // from the steps keeps the size it was measured at until it is measured again.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>(nodes);
  useEffect(() => {
    setRfNodes((prev) => nodes.map((n) => {
      const old = prev.find((p) => p.id === n.id);
      return old?.measured ? { ...n, measured: old.measured } : n;
    }));
  }, [nodes, setRfNodes]);

  const edges: Edge[] = useMemo(() => graph.edges.map((e) => {
    const look = EDGE_LOOK[e.kind];
    const lit = !selectedId || e.source === selectedId || e.target === selectedId;
    return {
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: "in",
      reconnectable: e.editable ? "target" : false,
      animated: lit && e.kind === "loop",
      label: e.label,
      style: { stroke: look.stroke, strokeWidth: lit ? 2.2 : 1.4, opacity: lit ? 1 : 0.35, strokeDasharray: look.dash },
      labelStyle: { fill: look.text, fontSize: 10 },
      labelBgStyle: { fill: "#0f172a" },
    };
  }), [graph, selectedId]);

  /** A refused edit says why; an edit that changes nothing changes nothing. */
  const apply = useCallback((result: BuilderStep[] | string) => {
    if (typeof result === "string") toast.error(result);
    else commit(result);
  }, [commit]);

  const connect = useCallback((c: Connection) => {
    if (c.source && c.target) apply(connectSteps(steps, c.source, c.sourceHandle, c.target));
  }, [steps, apply]);

  const pick = (id: string | null) => { setSelectedId(id); if (id) setInspectorOpen(true); };
  const at = selectedId ? locate(steps, selectedId) : null;
  const siblings = at ? listAt(steps, at.list) ?? [] : [];

  /** A new step of `type` — after the picked step, or at the end. */
  const add = (type: string, place: { list: ListRef; index: number } | null) => {
    const id = newStepId();
    const result = addNewStep(steps, type, id, place);
    apply(result);
    if (typeof result !== "string") pick(id);
  };
  const afterSelected = at ? { list: at.list, index: at.index + 1 } : null;

  // A palette card dropped on a step goes after it; dropped on a wire, where that wire leads; anywhere else, as a click.
  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    const type = event.dataTransfer.getData(DRAG_TYPE);
    if (!type) return;
    event.preventDefault();
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest(".react-flow__node, .react-flow__edge");
    const id = hit?.getAttribute("data-id") ?? "";
    const wire = hit?.classList.contains("react-flow__edge") ? graph.edges.find((e) => e.id === id) : undefined;
    const point = wire ? insertionPoint(steps, wire.source, wire.sourceHandle) : id ? insertionPoint(steps, id, "out") : null;
    add(type, point ?? afterSelected);
  };

  // Shortcuts belong to THIS canvas (every journey on the page mounts one), so they are read where focus is, not on
  // window — except Esc out of full screen, which only one canvas can be in.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    } else if (key === "f" && !event.shiftKey) {
      event.preventDefault();
      setFindOpen(true);
    }
  };
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[role="dialog"], [role="alertdialog"]')) setFullscreen(false);
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; };
  }, [fullscreen]);

  const query = paletteQuery.trim().toLowerCase();
  const groups = JOURNEY_PALETTE.map((g) => ({
    ...g,
    types: g.types
      // Not offered when its module is off here (journeyModules.ts) — the service reminder without Automotive.
      .filter((type) => !stepBlocked(type))
      .filter((type) => !query || `${labels[type]} ${STEP_META[type]?.description ?? ""} ${type}`.toLowerCase().includes(query)),
  })).filter((g) => g.types.length > 0);
  const hits = findOpen ? findSteps(steps, findQuery) : [];
  const jumpTo = (id: string) => { pick(id); setFindOpen(false); };

  return (
    <div onKeyDown={onKeyDown}>
    <BuilderWorkspaceShell fullscreen={fullscreen} className="h-[760px] min-h-0">
      <BuilderWorkspaceBar title="Journey steps" description="Steps run left to right. Click a step to edit it; drag a wire onto a step to move it there.">
        <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.035] p-0.5">
          <button type="button" onClick={() => setPaletteOpen((value) => !value)} className={cn("flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-slate-300 hover:bg-white/7", paletteOpen && "bg-primary/15 text-primary")}>
            {paletteOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />} Nodes
          </button>
          <button type="button" onClick={() => setInspectorOpen((value) => !value)} className={cn("flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-slate-300 hover:bg-white/7", inspectorOpen && "bg-primary/15 text-primary")}>
            {inspectorOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />} Inspector
          </button>
        </div>
        <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.035] p-0.5">
          <button type="button" onClick={undo} disabled={!historyDepth.undo} className="grid size-8 place-items-center rounded-md text-slate-300 hover:bg-white/7 disabled:cursor-not-allowed disabled:opacity-35" title="Undo (Ctrl+Z)"><Undo2 className="size-4" /><span className="sr-only">Undo</span></button>
          <button type="button" onClick={redo} disabled={!historyDepth.redo} className="grid size-8 place-items-center rounded-md text-slate-300 hover:bg-white/7 disabled:cursor-not-allowed disabled:opacity-35" title="Redo (Ctrl+Shift+Z)"><Redo2 className="size-4" /><span className="sr-only">Redo</span></button>
        </div>
        <button type="button" onClick={() => setFindOpen((value) => !value)} className={cn("btn-secondary btn-sm", findOpen && "border-orange-400/40 text-orange-200")} title="Find a step (Ctrl+F)"><Search className="size-4" /><span className="hidden sm:inline">Find</span></button>
        {fullscreen && saveButton}
        <button type="button" onClick={() => setFullscreen((value) => !value)} className="btn-secondary btn-sm" title={fullscreen ? "Exit full screen" : "Full screen"}>
          {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}<span className="hidden sm:inline">{fullscreen ? "Exit" : "Full screen"}</span>
        </button>
      </BuilderWorkspaceBar>

      <div className="relative flex min-h-0 flex-1">
        {paletteOpen && (
          <aside className="w-72 shrink-0 overflow-y-auto border-r border-white/[0.08] bg-[#111614] max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-[80] max-lg:max-h-[72dvh] max-lg:w-auto max-lg:rounded-t-3xl max-lg:border-t max-lg:shadow-[0_-24px_70px_rgba(0,0,0,.55)]">
            <div className="sticky top-0 z-10 border-b border-white/[0.08] bg-[#111614]/95 p-3 backdrop-blur">
              <div className="flex items-center justify-between gap-3 px-1 pb-3">
                <div><p className="text-sm font-semibold text-white">Step palette</p><p className="text-xs text-slate-400">Drag onto a step or wire, or click to add{at ? " after the selected step" : " at the end"}</p></div>
                <button type="button" onClick={() => setPaletteOpen(false)} className="grid size-10 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-4" /><span className="sr-only">Close step palette</span></button>
              </div>
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
                <input value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} className="input h-10 pl-9" placeholder="Search steps…" aria-label="Search steps" />
              </label>
            </div>
            <div className="space-y-5 p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">
              {groups.map((group) => (
                <section key={group.group}>
                  <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500">{group.label}</p>
                  <div className="grid gap-2">
                    {group.types.map((type) => {
                      const look = GROUP_LOOK[group.group];
                      const Icon = STEP_META[type]?.icon ?? FileQuestion;
                      return (
                        <button
                          key={type}
                          type="button"
                          draggable
                          onDragStart={(event) => { event.dataTransfer.setData(DRAG_TYPE, type); event.dataTransfer.effectAllowed = "copy"; }}
                          onClick={() => add(type, afterSelected)}
                          className={cn("group flex min-h-14 items-center gap-3 rounded-xl border bg-white/[0.025] px-3 py-2.5 text-left text-sm text-slate-200 transition hover:-translate-y-px hover:bg-white/[0.055]", look.tone)}
                        >
                          <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", look.header)}><Icon className="size-4" /></span>
                          <span className="min-w-0"><span className="block font-medium">{labels[type]}</span><span className="mt-0.5 block text-[11px] leading-4 text-slate-500 group-hover:text-slate-400">{STEP_META[type]?.description}</span></span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
              {!groups.length && <div className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">No steps match “{paletteQuery}”.</div>}
            </div>
          </aside>
        )}

        <main className="min-w-0 flex-1 bg-[#0b0f0e] p-2 sm:p-3">
          {/* tabIndex: clicking the canvas puts focus here, so Ctrl+Z / Ctrl+F reach this canvas's onKeyDown. */}
          <div tabIndex={-1} className="relative h-full min-h-[32rem] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0f1412] outline-none" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={onDrop}>
            {findOpen && (
              <div className="absolute left-3 top-3 z-20 w-80 max-w-[calc(100%-1.5rem)] rounded-xl border border-white/10 bg-[#111614]/95 p-2 shadow-2xl backdrop-blur">
                <div className="flex items-center gap-2">
                  <Search className="size-4 shrink-0 text-slate-400" />
                  <input
                    autoFocus
                    className="input h-9 flex-1"
                    aria-label="Find a step"
                    placeholder="Find a step — e.g. quote, wait, SMS"
                    value={findQuery}
                    onChange={(e) => setFindQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setFindOpen(false);
                      // Enter would submit the journey's form.
                      if (e.key === "Enter") { e.preventDefault(); if (hits[0]) jumpTo(hits[0].id); }
                    }}
                  />
                  <button type="button" onClick={() => setFindOpen(false)} className="grid size-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-4" /><span className="sr-only">Close find</span></button>
                </div>
                {findQuery.trim() && (
                  <div className="mt-2 max-h-72 overflow-y-auto">
                    {hits.length === 0 ? <p className="px-2 py-1.5 text-xs text-slate-400">No step mentions “{findQuery.trim()}”.</p> : hits.map((hit) => (
                      <button key={hit.id} type="button" onClick={() => jumpTo(hit.id)} className={cn("block w-full rounded-lg px-2 py-1.5 text-left hover:bg-white/5", selectedId === hit.id && "bg-orange-500/10")}>
                        <span className="block truncate text-xs font-medium text-slate-100">{hit.label}</span>
                        <span className="block truncate text-[11px] text-slate-400">{hit.snippet}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <ReactFlow
              nodes={rfNodes}
              onNodesChange={onNodesChange}
              edges={edges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              deleteKeyCode={null}
              onNodeClick={(_, node) => pick(node.type === "step" ? node.id : null)}
              onPaneClick={() => setSelectedId(null)}
              onConnect={connect}
              onReconnect={(_, c) => connect(c)}
              isValidConnection={(c) => c.sourceHandle !== "no" && c.source !== c.target && c.target !== START_NODE && !c.target.startsWith("__stop:")}
              minZoom={0.2}
              maxZoom={1.8}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#25312d" gap={20} size={1} />
              {/* Same dark controls as the chatbot canvas — see FlowBuilder for why the selectors are written this way. */}
              <Controls
                showInteractive={false}
                className={
                  "!border-white/10 !bg-[#18201d] !text-white " +
                  "[&_button]:!border-white/10 " +
                  "[&_button]:!bg-[#18201d] " +
                  "[&_button]:!text-white " +
                  "[&_button:hover]:!bg-white/10 " +
                  "[&_button_svg]:!fill-current"
                }
              />
              <MiniMap pannable zoomable className="!bg-[#111614]" maskColor="rgba(0,0,0,.55)" nodeColor="#334155" />
              <Panel position="top-right" className="!m-3 hidden sm:block">
                <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#111614]/90 px-2.5 py-1.5 text-[11px] text-slate-400 shadow-lg backdrop-blur">
                  <MousePointer2 className="size-3.5" />Select to inspect · drag a wire onto a step to move it
                </div>
              </Panel>
            </ReactFlow>
          </div>
        </main>

        {inspectorOpen && (
          // w-96, not FlowBuilder's w-80: a Journey condition row (field, operator, value) needs the room.
          <aside className="w-96 shrink-0 overflow-y-auto border-l border-white/[0.08] bg-[#111614] max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-[81] max-lg:max-h-[78dvh] max-lg:w-auto max-lg:rounded-t-3xl max-lg:border-t max-lg:shadow-[0_-24px_70px_rgba(0,0,0,.55)]">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.08] bg-[#111614]/95 px-4 py-3 backdrop-blur"><div><p className="text-sm font-semibold text-white">Inspector</p><p className="text-xs text-slate-400">Configure the selected step</p></div><button type="button" onClick={() => setInspectorOpen(false)} className="grid size-10 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-4" /><span className="sr-only">Close inspector</span></button></div>
            <div className="space-y-5 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {!at ? (
                <p className="text-sm leading-6 text-slate-400">Select a step to edit it. Add steps from the Nodes palette. Drag from a step&apos;s output handle — or a branch&apos;s — onto another step to move that step there.</p>
              ) : (
                <div key={at.step.id} className="space-y-4">
                  <div className="flex items-center gap-2">
                    {(() => { const Icon = STEP_META[at.step.type]?.icon ?? FileQuestion; return <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", lookOf(at.step.type).header)}><Icon className="size-4" /></span>; })()}
                    <div className="min-w-0"><p className="truncate text-sm font-semibold text-white">{labels[at.step.type] ?? at.step.type}</p><p className="truncate text-xs text-slate-500">Step {at.step.id}</p></div>
                  </div>
                  <StepEditor render={renderEditor} step={at.step} depth={at.depth} onStepChange={(next) => commit(updateStep(steps, at.step.id, next), `edit:${at.step.id}`)} />
                  <div className="grid grid-cols-2 gap-2 border-t border-white/[0.08] pt-4">
                    <button type="button" className="btn-secondary btn-sm" onClick={() => add("wait", { list: at.list, index: at.index })}><Plus className="size-3.5" />Step before</button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => add("wait", { list: at.list, index: at.index + 1 })}><Plus className="size-3.5" />Step after</button>
                    <button type="button" className="btn-secondary btn-sm" disabled={at.index === 0} onClick={() => apply(moveStep(steps, at.step.id, at.list, at.index - 1))}><ArrowUp className="size-3.5" />Earlier</button>
                    <button type="button" className="btn-secondary btn-sm" disabled={at.index === siblings.length - 1} onClick={() => apply(moveStep(steps, at.step.id, at.list, at.index + 2))}><ArrowDown className="size-3.5" />Later</button>
                  </div>
                  <button
                    type="button"
                    className="btn-danger btn-sm w-full"
                    disabled={Boolean(at.list) && siblings.length === 1}
                    title={at.list && siblings.length === 1 ? "A branch needs at least one step" : undefined}
                    onClick={() => { apply(removeStep(steps, at.step.id)); setSelectedId(null); }}
                  >
                    Delete step
                  </button>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </BuilderWorkspaceShell>
    </div>
  );
}
