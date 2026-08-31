"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ReactFlow, Background, Controls, Handle, Position,
  useNodesState, type Node, type Edge, type Connection, type NodeProps,
} from "@xyflow/react";
import { saveSignWorkflow } from "@/app/actions/signflow";
import { nid, CONDITION_FIELDS, CONDITION_OPS, CONDITION_LABEL, OP_LABEL, SIGNER_MODES, type SignNode, type WorkflowGraph, type ConditionField, type ConditionOp, type SignerMode } from "@/lib/signflow/model";

type Pos = { x: number; y: number };
type RFData = { node: SignNode; isStart: boolean };
type StaffOption = { id: string; name: string };

const TYPE_META: Record<SignNode["type"], { icon: string; label: string; color: string }> = {
  start: { icon: "▶", label: "Start", color: "#0891b2" },
  signer: { icon: "✍", label: "Signer", color: "#2563eb" },
  condition: { icon: "🔀", label: "Condition", color: "#7c3aed" },
  approval: { icon: "🛡", label: "Approval", color: "#d97706" },
  end: { icon: "✅", label: "Complete", color: "#059669" },
};

const MODE_LABEL: Record<SignerMode, string> = {
  staff: "Denago staff", role: "Role", owner: "Any owner/admin", customer: "The customer", email: "Fixed email", ask: "Choose at send",
};

function whoLabel(who: { mode: SignerMode; userId?: string; role?: string; email?: string }, staff: StaffOption[]): string {
  return who.mode === "staff" ? (staff.find((s) => s.id === who.userId)?.name ?? "Denago staff")
    : who.mode === "role" ? (who.role || "a role")
    : who.mode === "email" ? (who.email || "an email")
    : MODE_LABEL[who.mode];
}

function summary(n: SignNode, staff: StaffOption[] = []): string {
  if (n.type === "signer") return `${n.label || "Signer"} — ${whoLabel(n.who, staff)}${n.role === "approver" ? " (approver)" : ""}`;
  if (n.type === "approval") return `${n.label || "Approval"} — ${whoLabel(n.who, staff)} · ${n.mode === "signature" ? "signs" : "approve/reject"}`;
  if (n.type === "condition") return `If ${CONDITION_LABEL[n.field]} ${OP_LABEL[n.op]} ${n.value || "…"}`;
  if (n.type === "start") return "Workflow begins";
  return "Everyone has signed → seal & file";
}

function NodeCard({ data }: NodeProps) {
  const d = data as unknown as RFData;
  const n = d.node;
  const meta = TYPE_META[n.type];
  return (
    <div className="w-56 rounded-lg border bg-slate-900 text-slate-100 shadow-md" style={{ borderColor: d.isStart ? "#ea580c" : meta.color }}>
      {n.type !== "start" && <Handle type="target" position={Position.Left} id="in" style={{ background: "#64748b" }} />}
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold" style={{ background: meta.color }}>
        <span>{meta.icon}</span>{meta.label}
        {d.isStart && <span className="ml-auto rounded bg-orange-600 px-1.5 text-[10px]">START</span>}
      </div>
      <div className="min-h-8 whitespace-pre-wrap px-3 py-2 text-xs text-slate-300">{summary(n)}</div>
      {n.type === "condition" ? (
        <div className="pb-1">
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-emerald-400">Yes →
            <Handle type="source" position={Position.Right} id="true" style={{ top: 100, background: "#059669" }} />
          </div>
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-rose-400">No →
            <Handle type="source" position={Position.Right} id="false" style={{ top: 126, background: "#e11d48" }} />
          </div>
        </div>
      ) : n.type === "approval" ? (
        <div className="pb-1">
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-emerald-400">Approved →
            <Handle type="source" position={Position.Right} id="approved" style={{ top: 100, background: "#059669" }} />
          </div>
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-rose-400">Rejected →
            <Handle type="source" position={Position.Right} id="rejected" style={{ top: 126, background: "#e11d48" }} />
          </div>
        </div>
      ) : n.type === "end" ? null : (
        <Handle type="source" position={Position.Right} id="out" style={{ background: meta.color }} />
      )}
    </div>
  );
}

const nodeTypes = { signNode: NodeCard };

function blankNode(type: SignNode["type"], id: string): SignNode {
  switch (type) {
    case "signer": return { id, type, label: "Signer", who: { mode: "customer" }, role: "signer" };
    case "approval": return { id, type, label: "Approval", mode: "decision", who: { mode: "staff" } };
    case "condition": return { id, type, field: "total", op: "gt", value: "500000" };
    case "end": return { id, type };
    default: return { id, type: "start" };
  }
}

export default function SignFlowBuilder({ workflowId, name, initial, staff }: { workflowId: string; name: string; initial: WorkflowGraph; staff: StaffOption[] }) {
  const router = useRouter();
  const [start, setStart] = useState(initial.start);
  const [wfName, setWfName] = useState(name);
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<RFData>>(
    Object.values(initial.nodes).map((n, i) => ({
      id: n.id, type: "signNode",
      position: initial.positions?.[n.id] ?? { x: (i % 4) * 280 + 40, y: Math.floor(i / 4) * 200 + 40 },
      data: { node: n, isStart: n.id === initial.start },
    }))
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const patch = useCallback((id: string, updater: (n: SignNode) => SignNode) => {
    setRfNodes((ns) => ns.map((rn) => (rn.id === id ? { ...rn, data: { ...rn.data, node: updater(rn.data.node) } } : rn)));
  }, [setRfNodes]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    const add = (source: string, handle: string, target: string | undefined, color: string, label?: string) => {
      if (target && rfNodes.some((x) => x.id === target)) out.push({ id: `${source}:${handle}`, source, sourceHandle: handle, target, label, animated: true, style: { stroke: color } });
    };
    for (const rn of rfNodes) {
      const n = rn.data.node;
      if (n.type === "condition") { add(n.id, "true", n.whenTrue, "#059669", "yes"); add(n.id, "false", n.whenFalse, "#e11d48", "no"); }
      else if (n.type === "approval") { add(n.id, "approved", n.whenApproved, "#059669", "approved"); add(n.id, "rejected", n.whenRejected, "#e11d48", "rejected"); }
      else if (n.type !== "end") add(n.id, "out", (n as { next?: string }).next, "#475569");
    }
    return out;
  }, [rfNodes]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !c.sourceHandle) return;
    patch(c.source, (n) => {
      if (n.type === "condition" && c.sourceHandle === "true") return { ...n, whenTrue: c.target! };
      if (n.type === "condition" && c.sourceHandle === "false") return { ...n, whenFalse: c.target! };
      if (n.type === "approval" && c.sourceHandle === "approved") return { ...n, whenApproved: c.target! };
      if (n.type === "approval" && c.sourceHandle === "rejected") return { ...n, whenRejected: c.target! };
      return { ...n, next: c.target! } as SignNode;
    });
  }, [patch]);

  function addNode(type: SignNode["type"]) {
    const id = nid(type);
    setRfNodes((ns) => [...ns, { id, type: "signNode", position: { x: 140 + Math.random() * 220, y: 120 + Math.random() * 220 }, data: { node: blankNode(type, id), isStart: false } }]);
    setSelectedId(id);
  }
  function removeNode(id: string) {
    setRfNodes((ns) => ns.filter((n) => n.id !== id).map((n) => ({ ...n, data: { ...n.data, node: clearRefs(n.data.node, id) } })));
    if (selectedId === id) setSelectedId(null);
  }
  function markStart(id: string) {
    setStart(id);
    setRfNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, isStart: n.id === id } })));
  }

  async function onSave() {
    setStatus("Saving…");
    const nodes: Record<string, SignNode> = {};
    const positions: Record<string, Pos> = {};
    for (const rn of rfNodes) { nodes[rn.id] = rn.data.node; positions[rn.id] = rn.position; }
    const res = await saveSignWorkflow(workflowId, wfName, JSON.stringify({ start, nodes, positions }));
    setStatus(res.ok ? "Saved ✓" : res.error ?? "Error");
    if (res.ok) router.refresh();
  }

  const selected = rfNodes.find((n) => n.id === selectedId)?.data.node ?? null;
  const nodeOptions = rfNodes.filter((n) => n.id !== selectedId).map((n) => ({ id: n.id, label: `${TYPE_META[n.data.node.type].icon} ${summary(n.data.node, staff).slice(0, 26)}` }));

  return (
    <div className="flex min-h-[720px] flex-col md:h-[calc(100dvh-9rem)] md:min-h-0">
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <input className="input btn-sm w-56" value={wfName} onChange={(e) => setWfName(e.target.value)} placeholder="Workflow name" />
        <span className="ml-2 mr-1 text-xs text-slate-400">Add:</span>
        {(["signer", "approval", "condition", "end"] as SignNode["type"][]).map((t) => (
          <button key={t} onClick={() => addNode(t)} className="btn-secondary btn-sm">{TYPE_META[t].icon} {TYPE_META[t].label}</button>
        ))}
        <span className="flex-1" />
        {status && <span className="text-xs text-slate-400">{status}</span>}
        <button onClick={onSave} className="btn-primary btn-sm">Save workflow</button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
        <div className="min-h-96 flex-1 overflow-hidden rounded-xl border border-slate-800">
          <ReactFlow nodes={rfNodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)} onPaneClick={() => setSelectedId(null)} fitView proOptions={{ hideAttribution: true }}>
            <Background color="#1e293b" gap={18} />
            {/* Same defect as the chatbot flow builder: React Flow styles
                `.react-flow__controls-button` itself, so theming only the
                wrapper leaves white buttons on a dark canvas. */}
            <Controls
              className={
                "!border-slate-700 !bg-slate-800 " +
                "[&_.react-flow__controls-button]:!border-slate-700 " +
                "[&_.react-flow__controls-button]:!bg-slate-800 " +
                "[&_.react-flow__controls-button]:!text-slate-100 " +
                "[&_.react-flow__controls-button:hover]:!bg-slate-700 " +
                "[&_.react-flow__controls-button_svg]:!fill-current"
              }
            />
          </ReactFlow>
        </div>
        <div className="card max-h-80 w-full shrink-0 overflow-y-auto md:max-h-none md:w-72">
          {!selected ? (
            <p className="text-sm text-slate-400">Click a node to edit it. Drag from a node&apos;s right dot to another to connect. The <b className="text-orange-400">START</b> node begins the workflow; signers run top-to-bottom in the order they&apos;re connected.</p>
          ) : (
            <NodePanel key={selected.id} node={selected} isStart={selected.id === start} staff={staff} nodeOptions={nodeOptions}
              onChange={(fn) => patch(selected.id, () => fn)} onDelete={() => removeNode(selected.id)} onMakeStart={() => markStart(selected.id)} />
          )}
        </div>
      </div>
    </div>
  );
}

function clearRefs(n: SignNode, removed: string): SignNode {
  if (n.type === "condition") return { ...n, whenTrue: n.whenTrue === removed ? undefined : n.whenTrue, whenFalse: n.whenFalse === removed ? undefined : n.whenFalse };
  if (n.type === "approval") return { ...n, whenApproved: n.whenApproved === removed ? undefined : n.whenApproved, whenRejected: n.whenRejected === removed ? undefined : n.whenRejected };
  if (n.type === "end") return n;
  const nn = n as { next?: string };
  return nn.next === removed ? ({ ...n, next: undefined } as SignNode) : n;
}

type Who = { mode: SignerMode; userId?: string; role?: string; email?: string; name?: string };

/** Shared "who acts" picker used by signer + approval nodes. */
function WhoFields({ who, staff, onChange, label }: { who: Who; staff: StaffOption[]; onChange: (w: Who) => void; label: string }) {
  return (
    <>
      <div><label className="label">{label}</label>
        <select className="input" value={who.mode} onChange={(e) => onChange({ mode: e.target.value as SignerMode })}>
          {SIGNER_MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </select></div>
      {who.mode === "staff" && (
        <div><label className="label">Staff member</label>
          <select className="input" value={who.userId ?? ""} onChange={(e) => onChange({ ...who, userId: e.target.value || undefined })}>
            <option value="">— pick a person —</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></div>
      )}
      {who.mode === "role" && (
        <div><label className="label">Role name</label>
          <input className="input" value={who.role ?? ""} onChange={(e) => onChange({ ...who, role: e.target.value })} placeholder="e.g. Finance" />
          <input className="input mt-1" value={who.email ?? ""} onChange={(e) => onChange({ ...who, email: e.target.value })} placeholder="Optional fixed email to notify" /></div>
      )}
      {who.mode === "email" && (
        <div className="space-y-1.5">
          <div><label className="label">Name</label><input className="input" value={who.name ?? ""} onChange={(e) => onChange({ ...who, name: e.target.value })} /></div>
          <div><label className="label">Email</label><input className="input" value={who.email ?? ""} onChange={(e) => onChange({ ...who, email: e.target.value })} placeholder="person@example.com" /></div>
        </div>
      )}
      {who.mode === "owner" && <p className="text-xs text-slate-500">Any account owner / governance admin can action this.</p>}
      {who.mode === "customer" && <p className="text-xs text-slate-500">Resolves to the customer on the quote / job card automatically.</p>}
      {who.mode === "ask" && <p className="text-xs text-slate-500">You&apos;ll be asked who this is when you send.</p>}
    </>
  );
}

function TargetPicker({ value, onPick, nodeOptions, label }: { value?: string; onPick: (v?: string) => void; nodeOptions: { id: string; label: string }[]; label: string }) {
  return (
    <div><label className="label">{label}</label>
      <select className="input btn-sm" value={value ?? ""} onChange={(e) => onPick(e.target.value || undefined)}>
        <option value="">— (ends here) —</option>
        {nodeOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </div>
  );
}

function NodePanel({ node, isStart, staff, nodeOptions, onChange, onDelete, onMakeStart }: {
  node: SignNode; isStart: boolean; staff: StaffOption[]; nodeOptions: { id: string; label: string }[];
  onChange: (n: SignNode) => void; onDelete: () => void; onMakeStart: () => void;
}) {
  const meta = TYPE_META[node.type];
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{meta.icon} {meta.label}</span>
        {!isStart && node.type !== "end" && <button onClick={onMakeStart} className="text-xs text-orange-400 hover:underline">Set as start</button>}
      </div>

      {node.type === "signer" && (
        <>
          <div><label className="label">Step label</label>
            <input className="input" value={node.label} onChange={(e) => onChange({ ...node, label: e.target.value })} placeholder="e.g. Manager" /></div>
          <WhoFields who={node.who} staff={staff} label="Who signs" onChange={(w) => onChange({ ...node, who: w })} />
          <div><label className="label">Step type</label>
            <select className="input" value={node.role} onChange={(e) => onChange({ ...node, role: e.target.value as "signer" | "approver" })}>
              <option value="signer">Signer</option><option value="approver">Approver</option>
            </select></div>
          <TargetPicker label="Then go to" nodeOptions={nodeOptions} value={node.next} onPick={(v) => onChange({ ...node, next: v })} />
        </>
      )}

      {node.type === "approval" && (
        <>
          <div><label className="label">Step label</label>
            <input className="input" value={node.label} onChange={(e) => onChange({ ...node, label: e.target.value })} placeholder="e.g. Manager approval" /></div>
          <div><label className="label">How they respond</label>
            <select className="input" value={node.mode} onChange={(e) => onChange({ ...node, mode: e.target.value as "decision" | "signature" })}>
              <option value="decision">Approve / reject (no signature)</option>
              <option value="signature">Sign the document as approver</option>
            </select></div>
          <WhoFields who={node.who} staff={staff} label="Who approves" onChange={(w) => onChange({ ...node, who: w })} />
          <TargetPicker label="If approved → go to" nodeOptions={nodeOptions} value={node.whenApproved} onPick={(v) => onChange({ ...node, whenApproved: v })} />
          <TargetPicker label="If rejected → go to" nodeOptions={nodeOptions} value={node.whenRejected} onPick={(v) => onChange({ ...node, whenRejected: v })} />
        </>
      )}

      {node.type === "condition" && (
        <>
          <div><label className="label">Test</label>
            <select className="input" value={node.field} onChange={(e) => onChange({ ...node, field: e.target.value as ConditionField })}>
              {CONDITION_FIELDS.map((f) => <option key={f} value={f}>{CONDITION_LABEL[f]}</option>)}
            </select></div>
          <div className="grid grid-cols-2 gap-2">
            <div><label className="label">Is</label>
              <select className="input" value={node.op} onChange={(e) => onChange({ ...node, op: e.target.value as ConditionOp })}>
                {CONDITION_OPS.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
              </select></div>
            <div><label className="label">Value</label>
              <input className="input" value={node.value} onChange={(e) => onChange({ ...node, value: e.target.value })} placeholder={node.field === "total" ? "500000" : node.field === "discount" ? "10" : "dealer"} /></div>
          </div>
          <TargetPicker label="If yes → go to" nodeOptions={nodeOptions} value={node.whenTrue} onPick={(v) => onChange({ ...node, whenTrue: v })} />
          <TargetPicker label="If no → go to" nodeOptions={nodeOptions} value={node.whenFalse} onPick={(v) => onChange({ ...node, whenFalse: v })} />
        </>
      )}

      {node.type === "start" && (
        <TargetPicker label="Then go to" nodeOptions={nodeOptions} value={node.next} onPick={(v) => onChange({ ...node, next: v })} />
      )}
      {node.type === "end" && <p className="text-xs text-slate-400">When the flow reaches here, everyone has signed — the hub seals the PDF, files it and notifies all parties.</p>}

      {!isStart && node.type !== "end" && <button onClick={onDelete} className="btn-danger btn-sm w-full">Delete node</button>}
    </div>
  );
}
