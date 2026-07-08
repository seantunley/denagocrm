"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
import type { FlowNode } from "@/lib/flow";

type Pos = { x: number; y: number };
type FlowData = { start: string; nodes: Record<string, FlowNode>; positions?: Record<string, Pos> };
type RFData = { flow: FlowNode; isStart: boolean };

const TYPE_META: Record<string, { icon: string; label: string; color: string }> = {
  message: { icon: "💬", label: "Message", color: "#334155" },
  choice: { icon: "🔀", label: "Menu", color: "#7c3aed" },
  capture: { icon: "✏️", label: "Ask & save", color: "#0891b2" },
  answer: { icon: "📄", label: "Answer", color: "#2563eb" },
  booking: { icon: "🔧", label: "Create booking", color: "#059669" },
  ai: { icon: "🤖", label: "AI answer", color: "#ea580c" },
  handoff: { icon: "🙋", label: "Hand off", color: "#d97706" },
  end: { icon: "⛔", label: "End", color: "#64748b" },
};

function summary(n: FlowNode): string {
  if (n.type === "message" || n.type === "handoff") return n.text?.slice(0, 60) ?? "";
  if (n.type === "capture") return `“${n.text.slice(0, 40)}” → {{${n.variable}}}`;
  if (n.type === "answer") return n.answerSource ? `Send ${n.answerSource}` : (n.text ?? "").slice(0, 50);
  if (n.type === "booking") return "Logs a workshop booking";
  if (n.type === "ai") return "Chats, grounded in your prices & brief";
  if (n.type === "choice") return n.text.slice(0, 50);
  return "";
}

/** Custom node card with the right handles for its type. */
function NodeCard({ id, data }: NodeProps) {
  const d = data as unknown as RFData;
  const n = d.flow;
  const meta = TYPE_META[n.type];
  return (
    <div
      className="rounded-lg border bg-slate-900 shadow-md w-56 text-slate-100"
      style={{ borderColor: d.isStart ? "#ea580c" : meta.color }}
    >
      <Handle type="target" position={Position.Left} id="in" style={{ background: "#64748b" }} />
      <div className="px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5" style={{ background: meta.color }}>
        <span>{meta.icon}</span>
        {meta.label}
        {d.isStart && <span className="ml-auto text-[10px] bg-orange-600 px-1.5 rounded">START</span>}
      </div>
      <div className="px-3 py-2 text-xs text-slate-300 min-h-8 whitespace-pre-wrap">{summary(n) || "…"}</div>

      {n.type === "choice" ? (
        <div className="pb-1">
          {n.options.map((o, i) => (
            <div key={o.id} className="relative px-3 py-1 text-[11px] text-slate-400 border-t border-slate-800">
              {o.label}
              <Handle type="source" position={Position.Right} id={`opt:${o.id}`} style={{ top: `${100 + i * 26}px`, background: meta.color }} />
            </div>
          ))}
        </div>
      ) : n.type === "ai" ? (
        <Handle type="source" position={Position.Right} id="handoff" style={{ background: "#d97706" }} />
      ) : n.type === "handoff" || n.type === "end" ? null : (
        <Handle type="source" position={Position.Right} id="out" style={{ background: meta.color }} />
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
    case "answer": return { id, type, answerSource: "pricelist" };
    case "booking": return { id, type, text: "Thanks — the team will confirm shortly." };
    case "ai": return { id, type };
    case "handoff": return { id, type, text: "Let me get a team member to help — one moment 🙌" };
    default: return { id, type: "end" };
  }
}

export default function FlowBuilder({ initial }: { initial: FlowData }) {
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
  const [status, setStatus] = useState<string | null>(null);

  const patch = useCallback((id: string, updater: (n: FlowNode) => FlowNode) => {
    setRfNodes((ns) => ns.map((rn) => (rn.id === id ? { ...rn, data: { ...rn.data, flow: updater(rn.data.flow) } } : rn)));
  }, [setRfNodes]);

  // edges derived from node data
  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const rn of rfNodes) {
      const n = rn.data.flow;
      const add = (handle: string, target?: string) => {
        if (target && rfNodes.some((x) => x.id === target)) out.push({ id: `${n.id}:${handle}`, source: n.id, sourceHandle: handle, target, animated: true, style: { stroke: "#475569" } });
      };
      if (n.type === "choice") n.options.forEach((o) => add(`opt:${o.id}`, o.next));
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
      if (n.type === "ai" && c.sourceHandle === "handoff") return { ...n, handoffNext: c.target! };
      return { ...n, next: c.target! } as FlowNode;
    });
  }, [patch]);

  function addNode(type: FlowNode["type"]) {
    const id = newId(type);
    setRfNodes((ns) => [...ns, { id, type: "flowNode", position: { x: 120 + Math.random() * 200, y: 120 + Math.random() * 200 }, data: { flow: blankNode(type, id), isStart: false } }]);
    setSelectedId(id);
  }

  function removeNode(id: string) {
    setRfNodes((ns) => ns.filter((n) => n.id !== id).map((n) => ({
      ...n,
      data: { ...n.data, flow: clearRefs(n.data.flow, id) },
    })));
    if (selectedId === id) setSelectedId(null);
  }

  function markStart(id: string) {
    setStart(id);
    setRfNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, isStart: n.id === id } })));
  }

  async function onSave() {
    setStatus("Saving…");
    const nodes: Record<string, FlowNode> = {};
    const positions: Record<string, Pos> = {};
    for (const rn of rfNodes) {
      nodes[rn.id] = rn.data.flow;
      positions[rn.id] = rn.position;
    }
    const res = await saveFlow(JSON.stringify({ start, nodes, positions }));
    setStatus(res.ok ? "Saved ✓" : res.error ?? "Error");
    if (res.ok) router.refresh();
  }

  const selected = rfNodes.find((n) => n.id === selectedId)?.data.flow ?? null;
  const nodeOptions = rfNodes.map((n) => ({ id: n.id, label: `${TYPE_META[n.data.flow.type].icon} ${summary(n.data.flow).slice(0, 24) || n.data.flow.type}` }));

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 8rem)" }}>
      {/* toolbar */}
      <div className="flex items-center gap-2 flex-wrap pb-3">
        <span className="text-xs text-slate-400 mr-1">Add:</span>
        {(Object.keys(TYPE_META) as FlowNode["type"][]).map((t) => (
          <button key={t} onClick={() => addNode(t)} className="btn-secondary btn-sm">
            {TYPE_META[t].icon} {TYPE_META[t].label}
          </button>
        ))}
        <span className="flex-1" />
        {status && <span className="text-xs text-slate-400">{status}</span>}
        <button onClick={onSave} className="btn-primary btn-sm">Save flow</button>
        <button
          onClick={async () => { if (confirm("Revert to the default flow? Your changes will be lost.")) { await resetFlow(); router.refresh(); } }}
          className="btn-secondary btn-sm"
        >
          Reset
        </button>
      </div>

      <div className="flex-1 flex gap-3 min-h-0">
        <div className="flex-1 rounded-xl border border-slate-800 overflow-hidden">
          <ReactFlow
            nodes={rfNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#1e293b" gap={18} />
            <Controls className="!bg-slate-800 !border-slate-700" />
          </ReactFlow>
        </div>

        {/* config panel */}
        <div className="w-72 shrink-0 card overflow-y-auto">
          {!selected ? (
            <p className="text-sm text-slate-400">
              Click a node to edit it. Drag from a node&apos;s right dot to another node to connect
              them. First node is the <b className="text-orange-400">START</b>.
            </p>
          ) : (
            <NodePanel
              key={selected.id}
              node={selected}
              isStart={selected.id === start}
              nodeOptions={nodeOptions.filter((o) => o.id !== selected.id)}
              onChange={(fn) => patch(selected.id, () => fn)}
              onDelete={() => removeNode(selected.id)}
              onMakeStart={() => markStart(selected.id)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function clearRefs(n: FlowNode, removedId: string): FlowNode {
  if (n.type === "choice") return { ...n, options: n.options.map((o) => (o.next === removedId ? { ...o, next: undefined } : o)) };
  if (n.type === "ai") return n.handoffNext === removedId ? { ...n, handoffNext: undefined } : n;
  const nn = n as { next?: string };
  return nn.next === removedId ? ({ ...n, next: undefined } as FlowNode) : n;
}

function NodePanel({
  node, isStart, nodeOptions, onChange, onDelete, onMakeStart,
}: {
  node: FlowNode;
  isStart: boolean;
  nodeOptions: { id: string; label: string }[];
  onChange: (n: FlowNode) => void;
  onDelete: () => void;
  onMakeStart: () => void;
}) {
  const meta = TYPE_META[node.type];
  const TargetPicker = ({ value, onPick }: { value?: string; onPick: (v?: string) => void }) => (
    <select className="input btn-sm" value={value ?? ""} onChange={(e) => onPick(e.target.value || undefined)}>
      <option value="">— (ends here) —</option>
      {nodeOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{meta.icon} {meta.label}</span>
        {!isStart && <button onClick={onMakeStart} className="text-xs text-orange-400 hover:underline">Set as start</button>}
      </div>

      {(node.type === "message" || node.type === "handoff") && (
        <div>
          <label className="label">Message</label>
          <textarea className="input" rows={4} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value })} />
        </div>
      )}

      {node.type === "capture" && (
        <>
          <div><label className="label">Question to ask</label>
            <textarea className="input" rows={3} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div>
          <div><label className="label">Save answer as</label>
            <input className="input" value={node.variable} onChange={(e) => onChange({ ...node, variable: e.target.value.replace(/\W/g, "") })} placeholder="name" />
            <p className="text-xs text-slate-500 mt-1">Use it later as <code>{`{{${node.variable || "name"}}}`}</code>.</p></div>
        </>
      )}

      {node.type === "answer" && (
        <>
          <div><label className="label">Answer type</label>
            <select className="input" value={node.answerSource ?? "static"} onChange={(e) => { const v = e.target.value; onChange(v === "static" ? { ...node, answerSource: undefined, text: node.text ?? "" } : { ...node, answerSource: v as "pricelist" | "colours", text: undefined }); }}>
              <option value="static">Custom text</option>
              <option value="pricelist">Price list (from products)</option>
              <option value="colours">Colours (from products)</option>
            </select></div>
          {!node.answerSource && (
            <div><label className="label">Text</label>
              <textarea className="input" rows={4} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div>
          )}
        </>
      )}

      {node.type === "ai" && (
        <p className="text-xs text-slate-400">
          Chats conversationally, grounded in your prices, hours and brief. Connect the amber dot to
          a node to control where it goes when it hands off (otherwise it just notifies the team).
        </p>
      )}
      {node.type === "booking" && (
        <div><label className="label">Confirmation message</label>
          <textarea className="input" rows={3} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div>
      )}

      {node.type === "choice" && (
        <div className="space-y-2">
          <div><label className="label">Prompt</label>
            <textarea className="input" rows={2} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div>
          <label className="label">Options</label>
          {node.options.map((o, i) => (
            <div key={o.id} className="rounded-lg border border-slate-800 p-2 space-y-1.5">
              <div className="flex gap-1.5">
                <input className="input btn-sm flex-1" value={o.label} onChange={(e) => onChange({ ...node, options: node.options.map((x) => x.id === o.id ? { ...x, label: e.target.value } : x) })} />
                <button onClick={() => onChange({ ...node, options: node.options.filter((x) => x.id !== o.id) })} className="text-slate-500 hover:text-red-400 text-sm px-1">✕</button>
              </div>
              <TargetPicker value={o.next} onPick={(v) => onChange({ ...node, options: node.options.map((x) => x.id === o.id ? { ...x, next: v } : x) })} />
              {i === 2 && node.options.length > 3 && <p className="text-[10px] text-amber-400">WhatsApp shows &gt;3 options as a list.</p>}
            </div>
          ))}
          <button onClick={() => onChange({ ...node, options: [...node.options, { id: `o${Date.now().toString(36)}`, label: `Option ${node.options.length + 1}` }] })} className="btn-secondary btn-sm w-full">+ Add option</button>
        </div>
      )}

      {/* next target for linear nodes */}
      {(node.type === "message" || node.type === "answer" || node.type === "capture" || node.type === "booking") && (
        <div><label className="label">Then go to</label>
          <TargetPicker value={(node as { next?: string }).next} onPick={(v) => onChange({ ...node, next: v } as FlowNode)} /></div>
      )}
      {node.type === "ai" && (
        <div><label className="label">On hand-off, go to</label>
          <TargetPicker value={node.handoffNext} onPick={(v) => onChange({ ...node, handoffNext: v })} /></div>
      )}

      {!isStart && <button onClick={onDelete} className="btn-danger btn-sm w-full">Delete node</button>}
    </div>
  );
}
