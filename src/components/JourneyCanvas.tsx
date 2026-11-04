"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, CircleStop, Plus, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import {
  ReactFlow,
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
import { newWaitStep, type BuilderStep } from "@/lib/journeyBuilderDefinition";
import {
  START_NODE,
  connectSteps,
  insertStep,
  journeyGraph,
  listAt,
  locate,
  moveStep,
  removeStep,
  stepSummary,
  updateStep,
  type CanvasEdge,
  type CanvasHandle,
} from "@/lib/journeyCanvasGraph";
import { cn } from "@/lib/utils";

/**
 * The Journey as connected cards — the same steps the list view edits (lib/journeyCanvasGraph explains the wiring).
 * Cards sit where the layout puts them: the saved definition has no positions, and adding some would change what
 * the builder saves.
 */

const labels: Record<string, string> = JOURNEY_STEP_LABELS;
const handleClass = "!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125";

function tone(type: string): string {
  if (!(type in labels)) return "border-amber-400/60";
  if (type.startsWith("send_")) return "border-sky-400/40";
  if (type === "condition" || type === "choose") return "border-fuchsia-400/40";
  if (type === "repeat") return "border-teal-400/40";
  if (type.startsWith("wait") || type === "stop" || type === "variables") return "border-slate-400/50";
  return "border-emerald-400/40";
}

type StepData = { step: BuilderStep; handles: CanvasHandle[] };

function StepCard({ data, selected }: NodeProps<Node<StepData>>) {
  const { step, handles } = data;
  const known = step.type in labels;
  const single = handles.length === 1 && !handles[0].label;
  return (
    <div className={cn(
      "relative w-60 rounded-xl border bg-slate-950/95 text-slate-100 shadow-xl transition-[box-shadow,border-color] duration-150",
      tone(step.type),
      selected && "ring-2 ring-orange-400/60",
      step.enabled === false && "border-dashed opacity-50",
    )}>
      <Handle type="target" position={Position.Left} id="in" className={handleClass} style={{ background: "#64748b" }} />
      <div className="flex items-center gap-1.5 rounded-t-[11px] bg-white/[0.04] px-3 py-2 text-xs font-semibold">
        <span className="truncate">{known ? labels[step.type] : step.type}</span>
        {step.enabled === false && <span className="ml-auto rounded bg-slate-600 px-1.5 text-[10px] text-white" title="Switched off — runs skip this step">OFF</span>}
        {!known && <span className={cn("rounded bg-amber-600 px-1.5 text-[10px] text-white", step.enabled !== false && "ml-auto")} title="This build doesn't know this step type. It is kept exactly as saved.">UNKNOWN</span>}
      </div>
      <div className="min-h-8 whitespace-pre-wrap px-3 py-2 text-xs leading-5 text-slate-300">{stepSummary(step) || "…"}</div>
      {single ? (
        <Handle type="source" position={Position.Right} id="out" className={handleClass} style={{ background: "#94a3b8" }} />
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
                style={{ background: h.tone === "yes" ? "#34d399" : h.tone === "no" ? "#f87171" : "#a78bfa" }}
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
    <div className="relative w-52 rounded-xl border border-orange-400/70 bg-slate-950/95 px-3 py-2 text-slate-100 shadow-xl ring-2 ring-orange-400/15">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-orange-200"><Workflow className="size-3.5" />Journey starts</div>
      <p className="mt-1 text-[11px] text-slate-400">When a trigger enrols someone</p>
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

export default function JourneyCanvas({
  steps,
  onChange,
  renderEditor,
}: {
  steps: BuilderStep[];
  onChange: (steps: BuilderStep[]) => void;
  /** The list view's own step editors, for the selected step. */
  renderEditor: (step: BuilderStep, depth: number, onStepChange: (step: BuilderStep) => void) => ReactNode;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const graph = useMemo(() => journeyGraph(steps), [steps]);

  const nodes: Node[] = useMemo(() => graph.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: { x: n.x, y: n.y },
    selected: n.id === selectedId,
    data: n.kind === "step" ? { step: n.step, handles: n.handles } : n.kind === "stop" ? { label: n.label } : {},
  })), [graph, selectedId]);

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
    else if (result !== steps) onChange(result);
  }, [steps, onChange]);

  const connect = useCallback((c: Connection) => {
    if (c.source && c.target) apply(connectSteps(steps, c.source, c.sourceHandle, c.target));
  }, [steps, apply]);

  const at = selectedId ? locate(steps, selectedId) : null;
  const siblings = at ? listAt(steps, at.list) ?? [] : [];
  const add = (index: number) => {
    const step = newWaitStep();
    onChange(insertStep(steps, at?.list ?? null, index, step));
    setSelectedId(step.id);
  };

  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      <div className="relative h-[640px] min-w-0 flex-1 overflow-hidden rounded-xl border border-slate-800 bg-[#0d1110]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          deleteKeyCode={null}
          onNodeClick={(_, node) => setSelectedId(node.type === "step" ? node.id : null)}
          onPaneClick={() => setSelectedId(null)}
          onConnect={connect}
          onReconnect={(_, c) => connect(c)}
          isValidConnection={(c) => c.sourceHandle !== "no" && c.source !== c.target && c.target !== START_NODE && !c.target.startsWith("__stop:")}
          fitView
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
            <div className="rounded-lg border border-white/10 bg-[#111614]/90 px-2.5 py-1.5 text-[11px] text-slate-400 shadow-lg backdrop-blur">
              Click a step to edit · drag a wire to a step to move it there
            </div>
          </Panel>
        </ReactFlow>
      </div>

      <aside className="max-h-[640px] shrink-0 overflow-y-auto rounded-xl border border-slate-800 bg-[#111614] p-4 lg:w-96">
        {at ? (
          <div key={at.step.id} className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-white">{labels[at.step.type] ?? at.step.type}</p>
              <p className="text-xs text-slate-500">Step {at.step.id}</p>
            </div>
            {renderEditor(at.step, at.depth, (next) => onChange(updateStep(steps, at.step.id, next)))}
            <div className="grid grid-cols-2 gap-2 border-t border-slate-800 pt-4">
              <button type="button" className="btn-secondary btn-sm" onClick={() => add(at.index)}><Plus className="size-3.5" />Step before</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => add(at.index + 1)}><Plus className="size-3.5" />Step after</button>
              <button type="button" className="btn-secondary btn-sm" disabled={at.index === 0} onClick={() => apply(moveStep(steps, at.step.id, at.list, at.index - 1))}><ArrowUp className="size-3.5" />Earlier</button>
              <button type="button" className="btn-secondary btn-sm" disabled={at.index === siblings.length - 1} onClick={() => apply(moveStep(steps, at.step.id, at.list, at.index + 2))}><ArrowDown className="size-3.5" />Later</button>
              <button
                type="button"
                className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-40"
                disabled={Boolean(at.list) && siblings.length === 1}
                title={at.list && siblings.length === 1 ? "A branch needs at least one step" : undefined}
                onClick={() => { apply(removeStep(steps, at.step.id)); setSelectedId(null); }}
              >
                <Trash2 className="size-3.5" />Delete step
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm leading-6 text-slate-400">
            <p className="font-semibold text-white">Edit on the canvas</p>
            <p>Click a step to edit it here. Steps run left to right; a Choose runs one of its branches and a Repeat runs its loop, then the journey carries on.</p>
            <p>To move a step, drag from a step&apos;s output (or a branch&apos;s handle) onto it — it moves to right after that output.</p>
            <button type="button" className="btn-secondary btn-sm" onClick={() => add(steps.length)}><Plus className="size-3.5" />Add a step at the end</button>
          </div>
        )}
      </aside>
    </div>
  );
}
