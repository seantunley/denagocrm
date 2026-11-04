"use client";

import "@xyflow/react/dist/style.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BarChart3,
  Bot,
  Clock,
  SquareDashed,
  StickyNote,
  UserCog,
  CalendarDays,
  CircleStop,
  CornerDownRight,
  Copy,
  FileQuestion,
  FileUp,
  FlaskConical,
  GitBranch,
  Hand,
  History,
  ImageIcon,
  Maximize2,
  MessageSquare,
  Minimize2,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  Redo2,
  Save,
  Search,
  Sparkles,
  Upload,
  Undo2,
  FileText,
  Contact,
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
  NodeResizer,
  Panel,
  Position,
  useNodesState,
  type NodeChange,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { saveFlow, resetFlow } from "@/app/actions/flow";
import { uploadCampaignImage } from "@/app/actions/campaigns";
import { isAnnotation, type AnnotationColor, type BookingAction, type ConditionOperator, type CrmUpdateAction, type FlowHttpMethod, type FlowNode, type SlotAction } from "@/lib/flow";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import EmojiButton from "@/components/EmojiButton";
import { stepNumbersLine, type StepNumbers } from "@/lib/flowStepNumbers";
import { searchFlow } from "@/lib/flowSearch";
import { cn } from "@/lib/utils";
import { BuilderSaveStatus, BuilderWorkspaceBar, BuilderWorkspaceShell } from "@/components/builder-workspace";
import FlowLintPanel from "@/components/FlowLintPanel";
import FlowSimulator from "@/components/FlowSimulator";
import FlowReplayPanel from "@/components/FlowReplayPanel";
import type { ReplayStep } from "@/lib/flowReplayRun";
import { validateFlow, type FlowChannel, type FlowIssue } from "@/lib/flowValidation";

type Pos = { x: number; y: number };
type FlowData = { start: string; nodes: Record<string, FlowNode>; positions?: Record<string, Pos> };
/** `replay`: while a conversation is replayed, the step numbers it passed this node at (empty = not on its path). */
type RFData = { flow: FlowNode; isStart: boolean; issues?: FlowIssue[]; replay?: number[] };
/** The numbers on each step's card (lib/flowStepNumbers); null while switched off. */
const StepNumbersContext = createContext<StepNumbers | null>(null);
type EditorSnapshot = { start: string; nodes: Node<RFData>[] };
export type FlowJourneyOption = { id: string; name: string };
export type FlowOptionRef = { id: string; name: string };

const AUTOSAVE_DELAY_MS = 1_200;
const HISTORY_GROUP_MS = 700;
const HISTORY_LIMIT = 50;
const GRID_SIZE = 20;
const LARGE_FLOW_EDGE_ANIMATION_LIMIT = 40;

function cloneSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return structuredClone(snapshot);
}

function flowStorageKey(flowId: string): string {
  return `denagocrm:bot-flow-draft:${flowId}`;
}

const BUILTIN_VARIABLES = [
  "greeting", "first_name", "name", "known", "slot", "channel", "current_date", "current_time",
  "booking_identity", "booking_found", "booking_id", "booking_slot", "booking_summary", "booking_cancelled", "booking_rescheduled",
  "journey_started", "journey_reason", "journey_run_id",
];

const TYPE_META: Record<FlowNode["type"], { icon: LucideIcon; label: string; tone: string; header: string; handle: string; description: string }> = {
  message: { icon: MessageSquare, label: "Message", tone: "border-sky-400/40", header: "bg-sky-500/15 text-sky-200", handle: "#38bdf8", description: "Send text to the customer" },
  choice: { icon: GitBranch, label: "Menu", tone: "border-violet-400/40", header: "bg-violet-500/15 text-violet-200", handle: "#a78bfa", description: "Offer buttons or a list of choices" },
  capture: { icon: FileQuestion, label: "Ask & save", tone: "border-cyan-400/40", header: "bg-cyan-500/15 text-cyan-200", handle: "#22d3ee", description: "Ask a question and store the answer" },
  captureFile: { icon: FileUp, label: "Get a file", tone: "border-cyan-400/40", header: "bg-cyan-500/15 text-cyan-200", handle: "#22d3ee", description: "Capture an uploaded file" },
  image: { icon: ImageIcon, label: "Send image", tone: "border-violet-400/40", header: "bg-violet-500/15 text-violet-200", handle: "#a78bfa", description: "Send an image with an optional caption" },
  document: { icon: FileText, label: "Send a document", tone: "border-violet-400/40", header: "bg-violet-500/15 text-violet-200", handle: "#a78bfa", description: "Send one of your files — a brochure, a price list" },
  contactCard: { icon: Contact, label: "Send contact card", tone: "border-violet-400/40", header: "bg-violet-500/15 text-violet-200", handle: "#a78bfa", description: "Send your business (or a staff member's) contact card" },
  answer: { icon: Sparkles, label: "Answer", tone: "border-blue-400/40", header: "bg-blue-500/15 text-blue-200", handle: "#60a5fa", description: "Send a static or product-backed answer" },
  knowledge: { icon: Sparkles, label: "Knowledge answer", tone: "border-blue-400/40", header: "bg-blue-500/15 text-blue-200", handle: "#60a5fa", description: "Answer from approved Flowbot knowledge" },
  set: { icon: FileQuestion, label: "Set variable", tone: "border-fuchsia-400/40", header: "bg-fuchsia-500/15 text-fuchsia-200", handle: "#e879f9", description: "Set or update flow data" },
  switch: { icon: GitBranch, label: "Switch", tone: "border-fuchsia-400/40", header: "bg-fuchsia-500/15 text-fuchsia-200", handle: "#e879f9", description: "Route one value across multiple branches" },
  http: { icon: Workflow, label: "API request", tone: "border-indigo-400/40", header: "bg-indigo-500/15 text-indigo-200", handle: "#818cf8", description: "Call an HTTPS endpoint and store its response" },
  extract: { icon: Sparkles, label: "AI extract", tone: "border-orange-400/50", header: "bg-orange-500/15 text-orange-200", handle: "#fb923c", description: "Extract structured fields from customer text" },
  delay: { icon: CalendarDays, label: "Wait", tone: "border-slate-400/50", header: "bg-slate-500/15 text-slate-200", handle: "#94a3b8", description: "Hold quietly; the flow resumes with the next message after the time passes" },
  subflow: { icon: Workflow, label: "Run subflow", tone: "border-teal-400/40", header: "bg-teal-500/15 text-teal-200", handle: "#2dd4bf", description: "Run a reusable published flow" },
  slots: { icon: CalendarDays, label: "Workshop slots", tone: "border-emerald-400/40", header: "bg-emerald-500/15 text-emerald-200", handle: "#34d399", description: "Offer real booking availability" },
  booking: { icon: Wrench, label: "CRM / booking action", tone: "border-emerald-400/40", header: "bg-emerald-500/15 text-emerald-200", handle: "#34d399", description: "Create, find or update CRM work" },
  journey: { icon: Workflow, label: "Start Journey", tone: "border-teal-400/40", header: "bg-teal-500/15 text-teal-200", handle: "#2dd4bf", description: "Enrol the customer in a Journey" },
  condition: { icon: GitBranch, label: "Condition", tone: "border-fuchsia-400/40", header: "bg-fuchsia-500/15 text-fuchsia-200", handle: "#e879f9", description: "Branch on a deterministic rule" },
  ai: { icon: Bot, label: "AI answer", tone: "border-orange-400/50", header: "bg-orange-500/15 text-orange-200", handle: "#fb923c", description: "Use the existing grounded AI response" },
  handoff: { icon: Hand, label: "Hand off", tone: "border-amber-400/40", header: "bg-amber-500/15 text-amber-100", handle: "#fbbf24", description: "Transfer ownership to staff" },
  hours: { icon: Clock, label: "Opening hours", tone: "border-fuchsia-400/40", header: "bg-fuchsia-500/15 text-fuchsia-200", handle: "#e879f9", description: "Open or closed — your office hours and public holidays" },
  goto: { icon: CornerDownRight, label: "Go to", tone: "border-slate-400/50", header: "bg-slate-500/15 text-slate-200", handle: "#94a3b8", description: "Jump to another step — e.g. back to the menu — without a wire" },
  note: { icon: StickyNote, label: "Note", tone: "border-yellow-400/40", header: "bg-yellow-500/15 text-yellow-100", handle: "#facc15", description: "A sticky note for the team — never sent" },
  group: { icon: SquareDashed, label: "Group", tone: "border-sky-400/40", header: "bg-sky-500/15 text-sky-100", handle: "#38bdf8", description: "A coloured box to frame a section — never sent" },
  crm: { icon: UserCog, label: "Update the CRM", tone: "border-emerald-400/40", header: "bg-emerald-500/15 text-emerald-200", handle: "#34d399", description: "Tag the customer, set their salesperson or move their deal" },
  end: { icon: CircleStop, label: "End", tone: "border-slate-500/50", header: "bg-slate-500/15 text-slate-200", handle: "#94a3b8", description: "Finish the flow" },
};

const NODE_GROUPS: { label: string; types: FlowNode["type"][] }[] = [
  { label: "Messages", types: ["message", "image", "document", "contactCard", "answer", "knowledge", "choice"] },
  { label: "Customer input", types: ["capture", "captureFile"] },
  { label: "Logic & data", types: ["condition", "hours", "switch", "set", "delay", "goto"] },
  { label: "CRM & automation", types: ["booking", "crm", "slots", "journey", "http", "subflow"] },
  { label: "AI & operations", types: ["ai", "extract", "handoff", "end"] },
  { label: "Canvas — team only", types: ["note", "group"] },
];

function summary(n: FlowNode): string {
  if (n.type === "message" || n.type === "handoff") return n.text?.slice(0, 60) ?? "";
  if (n.type === "capture") return `“${n.text.slice(0, 40)}” → {{${n.variable}}}`;
  if (n.type === "captureFile") return `Ask for a file → {{${n.variable}}}`;
  if (n.type === "image") return n.url ? "Sends an image" : "(no image set)";
  if (n.type === "document") return n.documentId ? `Sends ${n.fileName ?? "a document"}` : "(no file chosen)";
  if (n.type === "contactCard") return n.staffUserId ? "Sends a staff member's contact card" : "Sends your business contact card";
  if (n.type === "hours") return n.holidaysClosed === false ? "Office hours (open on public holidays)" : "Office hours · closed on public holidays";
  if (n.type === "goto") return n.target ? `↪ ${n.targetLabel || n.target}` : "(choose a step to jump to)";
  if (n.type === "note") return n.text.slice(0, 60);
  if (n.type === "group") return n.label;
  if (n.type === "crm") {
    if (n.action === "tag") return n.tagName ? `Tag: ${n.tagName}` : "(choose a tag)";
    if (n.action === "assign") return n.userId ? `Salesperson: ${n.userLabel ?? "chosen"}` : "(choose a salesperson)";
    return n.stageId ? `Deal → ${n.stageLabel ?? "stage"}` : "(choose a stage)";
  }
  if (n.type === "answer") return n.answerSource ? `Send ${n.answerSource}` : (n.text ?? "").slice(0, 50);
  if (n.type === "slots") return n.action === "reschedule" ? "Moves an existing booking to a real open slot" : "Offers real open workshop slots";
  if (n.type === "booking") {
    if (n.action === "lookup") return "Finds this customer's next service booking";
    if (n.action === "cancel") return "Cancels the customer-owned booking in {{booking_id}}";
    return `Creates a ${n.action ?? "service"} in the CRM`;
  }
  if (n.type === "journey") return !n.journeyId ? "Choose a Journey" : n.after ? `Follow-up Journey in ${n.after.amount} ${n.after.unit}` : "Enrols this customer in an asynchronous Journey";
  if (n.type === "condition") {
    const op = n.condition.operator.replace("_", " ");
    return `{{${n.condition.variable || "variable"}}} ${op}${n.condition.value ? ` “${n.condition.value}”` : ""}`;
  }
  if (n.type === "knowledge") return n.query ? `Approved knowledge: ${n.query.slice(0, 38)}` : "Answer current message from approved knowledge";
  if (n.type === "set") return `{{${n.variable || "variable"}}} = ${n.value.slice(0, 34)}`;
  if (n.type === "switch") return `{{${n.variable || "variable"}}} · ${n.cases.length} case${n.cases.length === 1 ? "" : "s"}`;
  if (n.type === "http") return `${n.method} ${n.url || "(set URL)"}`.slice(0, 55);
  if (n.type === "extract") return `${n.fields.length} field${n.fields.length === 1 ? "" : "s"}: ${n.fields.join(", ")}`.slice(0, 55);
  if (n.type === "delay") return `Wait ${n.seconds}s (quiet hold — resumes on the next message)`;
  if (n.type === "subflow") return n.flowId ? "Run published reusable flow" : "Choose a subflow";
  if (n.type === "ai") return "Chats, grounded in your prices & brief";
  if (n.type === "choice") return n.text.slice(0, 50);
  return "";
}

/**
 * Notes and groups (Node-RED's comment node and groups; Sean, 2026-11-02): canvas only. A group sits BEHIND the steps
 * (zIndex -1) at its saved size; nothing can be wired to either.
 */
const ANNOTATION_COLORS: Record<AnnotationColor, { box: string; text: string }> = {
  yellow: { box: "border-yellow-400/50 bg-yellow-400/10", text: "text-yellow-100" },
  blue: { box: "border-sky-400/50 bg-sky-400/[0.07]", text: "text-sky-100" },
  green: { box: "border-emerald-400/50 bg-emerald-400/[0.07]", text: "text-emerald-100" },
  purple: { box: "border-fuchsia-400/50 bg-fuchsia-400/[0.07]", text: "text-fuchsia-100" },
  red: { box: "border-red-400/50 bg-red-400/[0.07]", text: "text-red-100" },
  slate: { box: "border-slate-400/50 bg-slate-400/[0.07]", text: "text-slate-100" },
};
function toRfNode(n: FlowNode, position: Pos, isStart: boolean): Node<RFData> {
  const base = { id: n.id, type: "flowNode", position, data: { flow: n, isStart } };
  return n.type === "group" ? { ...base, zIndex: -1, style: { width: n.width ?? 520, height: n.height ?? 320 } } : base;
}

function NodeCard({ data, selected }: NodeProps) {
  const d = data as unknown as RFData;
  const n = d.flow;
  // Before the note/group early returns: a hook must run on every render, in the same order.
  const stepNumbers = useContext(StepNumbersContext);
  if (n.type === "note") {
    const color = ANNOTATION_COLORS[n.color ?? "yellow"];
    return (
      <div className={cn("w-56 rounded-lg border px-3 py-2 text-xs leading-5 shadow-lg", color.box, color.text, selected && "ring-2 ring-white/30")}>
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-70"><StickyNote className="size-3" />Note</div>
        <p className="whitespace-pre-wrap">{n.text || "…"}</p>
      </div>
    );
  }
  if (n.type === "group") {
    const color = ANNOTATION_COLORS[n.color ?? "blue"];
    return (
      <div className={cn("h-full w-full rounded-2xl border-2 border-dashed", color.box, selected && "ring-2 ring-white/25")}>
        <NodeResizer isVisible={selected} minWidth={200} minHeight={120} lineClassName="!border-white/30" handleClassName="!size-2.5 !rounded-sm !border-slate-950 !bg-white/70" />
        <div className={cn("px-3 py-2 text-sm font-semibold", color.text)}>{n.label || "Section"}</div>
      </div>
    );
  }
  const meta = TYPE_META[n.type];
  const Icon = meta.icon;
  const numbers = stepNumbersLine(n.type, stepNumbers?.[n.id]);
  const errors = d.issues?.filter((issue) => issue.severity === "error").length ?? 0;
  const warnings = (d.issues?.length ?? 0) - errors;
  return (
    <div className={cn(
      "relative w-60 rounded-xl border bg-slate-950/95 text-slate-100 shadow-xl transition-[box-shadow,border-color,transform] duration-150",
      errors ? "border-red-400/80 ring-2 ring-red-400/20" : warnings ? "border-amber-400/70 ring-2 ring-amber-400/15" : d.isStart ? "border-orange-400/70 ring-2 ring-orange-400/15" : meta.tone,
      d.replay && (d.replay.length ? "ring-2 ring-orange-400/60" : "opacity-30"),
    )}>
      {d.replay && d.replay.length > 0 && <span className="absolute -left-2 -top-2 z-10 rounded-full border border-slate-950 bg-orange-500 px-1.5 py-0.5 text-[10px] font-bold text-white" title="Replay step numbers">{d.replay.length > 3 ? `${d.replay.slice(0, 3).join(", ")}…` : d.replay.join(", ")}</span>}
      {(errors > 0 || warnings > 0) && <span className={cn("absolute -right-2 -top-2 z-10 grid min-w-6 place-items-center rounded-full border border-slate-950 px-1.5 py-0.5 text-[10px] font-bold text-white", errors ? "bg-red-500" : "bg-amber-500")}>{errors || warnings}<span className="sr-only">{errors ? "errors" : "warnings"}</span></span>}
      <Handle type="target" position={Position.Left} id="in" className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: "#64748b" }} />
      <div className={cn("flex items-center gap-1.5 rounded-t-[11px] px-3 py-2 text-xs font-semibold", meta.header)}>
        <Icon className="size-3.5" />
        {meta.label}
        {d.isStart && <span className="ml-auto rounded bg-orange-600 px-1.5 text-[10px]">START</span>}
      </div>
      <div className="min-h-8 whitespace-pre-wrap px-3 py-2 text-xs leading-5 text-slate-300">{summary(n) || "…"}</div>
      {numbers && <div className="border-t border-slate-800 px-3 py-1 text-[10px] font-medium text-emerald-300/90" title="Last 30 days">{numbers}</div>}

      {n.type === "choice" ? (
        <div className="pb-1">
          {n.options.map((o) => (
            <div key={o.id} className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-slate-400">
              {o.label}
              <Handle type="source" position={Position.Right} id={`opt:${o.id}`} className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: meta.handle }} />
            </div>
          ))}
        </div>
      ) : n.type === "condition" ? (
        <div className="pb-1">
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-emerald-300">Yes
            <Handle type="source" position={Position.Right} id="true" className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: "#34d399" }} />
          </div>
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-red-300">No
            <Handle type="source" position={Position.Right} id="false" className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: "#f87171" }} />
          </div>
        </div>
      ) : n.type === "hours" ? (
        <div className="pb-1">
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-emerald-300">Open
            <Handle type="source" position={Position.Right} id="open" className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: "#34d399" }} />
          </div>
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-slate-400">Closed
            <Handle type="source" position={Position.Right} id="closed" className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: "#94a3b8" }} />
          </div>
        </div>
      ) : n.type === "switch" ? (
        <div className="pb-1">
          {n.cases.map((item) => (
            <div key={item.id} className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-fuchsia-200">
              {item.label || item.value || "Case"}
              <Handle type="source" position={Position.Right} id={`case:${item.id}`} className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: meta.handle }} />
            </div>
          ))}
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-slate-400">Default
            <Handle type="source" position={Position.Right} id="default" className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: "#94a3b8" }} />
          </div>
        </div>
      ) : n.type === "ai" ? (
        <Handle type="source" position={Position.Right} id="handoff" className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: meta.handle }} />
      ) : FALLIBLE.has(n.type) ? (
        <div className="pb-1">
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-emerald-300">Done
            <Handle type="source" position={Position.Right} id="out" className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: "#34d399" }} />
          </div>
          <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-amber-300">If it fails
            <Handle type="source" position={Position.Right} id="failure" className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: "#fbbf24" }} />
          </div>
          {(n.type === "slots" || Boolean((n as { unavailableNext?: string }).unavailableNext)) && (
            <div className="relative border-t border-slate-800 px-3 py-1 text-[11px] text-slate-400">If none available
              <Handle type="source" position={Position.Right} id="unavailable" className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: "#94a3b8" }} />
            </div>
          )}
        </div>
      ) : n.type === "handoff" || n.type === "end" || n.type === "goto" ? null : (
        <Handle type="source" position={Position.Right} id="out" className="!size-3 !border-2 !border-slate-950 transition-transform hover:!scale-125" style={{ background: meta.handle }} />
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
    case "document": return { id, type, documentId: "" };
    case "contactCard": return { id, type };
    case "goto": return { id, type, target: "" };
    case "note": return { id, type, text: "A note for the team", color: "yellow" };
    case "group": return { id, type, label: "Section", color: "blue", width: 520, height: 320 };
    case "crm": return { id, type, action: "tag", tagName: "" };
    case "answer": return { id, type, answerSource: "pricelist" };
    case "knowledge": return { id, type, query: "", noMatchText: "I couldn't find an approved answer for that." };
    case "set": return { id, type, variable: "status", value: "new" };
    case "switch": return { id, type, variable: "channel", cases: [{ id: "c1", value: "whatsapp", label: "WhatsApp" }] };
    case "http": return { id, type, method: "GET", url: "", failureText: "I couldn't reach that service just now." };
    case "extract": return { id, type, instruction: "Extract the requested customer details from their message.", fields: ["intent"], failureText: "I couldn't reliably read those details." };
    case "delay": return { id, type, seconds: 300 };
    case "subflow": return { id, type, flowId: "", failureText: "I couldn't complete that reusable flow." };
    case "slots": return { id, type, action: "book", text: "Here are our next open times — pick one:", noneText: "We're fully booked online — the team will call you." };
    case "booking": return { id, type, action: "service", text: "Thanks — the team will confirm shortly." };
    case "journey": return { id, type, journeyId: "", text: "You're all set — we'll keep you updated." };
    case "condition": return { id, type, condition: { variable: "channel", operator: "equals", value: "whatsapp" } };
    case "hours": return { id, type, holidaysClosed: true };
    case "ai": return { id, type };
    case "handoff": return { id, type, text: "Let me get a team member to help — one moment.", reason: "Flow requested human assistance" };
    default: return { id, type: "end" };
  }
}

export default function FlowBuilder({ flowId, initial, journeys = [], flows = [], updatedAt, channels, businessName, documents = [], staff = [], connections = [], crmTags = [], stages = [], stepNumbers = {}, stepNumbersDays = 30 }: { connections?: { id: string; name: string; host: string }[]; flowId: string; initial: FlowData; journeys?: FlowJourneyOption[]; flows?: FlowOptionRef[]; updatedAt: string; channels: FlowChannel[]; businessName: string; documents?: { id: string; name: string }[]; staff?: { id: string; name: string }[]; crmTags?: string[]; stages?: { id: string; name: string }[]; stepNumbers?: StepNumbers; stepNumbersDays?: number }) {
  const [showNumbers, setShowNumbers] = useState(true);
  const router = useRouter();
  const [start, setStart] = useState(initial.start);
  const [rfNodes, setRfNodes, applyNodesChange] = useNodesState<Node<RFData>>(
    Object.values(initial.nodes).map((n, i) => toRfNode(n, initial.positions?.[n.id] ?? { x: (i % 4) * 300 + 40, y: Math.floor(i / 4) * 220 + 40 }, n.id === initial.start))
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState("Saved");
  const [saveNonce, setSaveNonce] = useState(0);
  const [pendingDestination, setPendingDestination] = useState<string | null>(null);
  const savedAt = useRef<string>(updatedAt);
  const current = useRef<EditorSnapshot>({ start: initial.start, nodes: [] });
  const history = useRef<{ past: EditorSnapshot[]; future: EditorSnapshot[] }>({ past: [], future: [] });
  const historyGroup = useRef<{ key: string; at: number } | null>(null);
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 });
  const dirtyVersion = useRef(0);
  const saving = useRef(false);
  const saveAgain = useRef(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recovered = useRef(false);
  const blockedByConflict = useRef(false);

  useEffect(() => {
    current.current = { start, nodes: rfNodes };
  }, [rfNodes, start]);

  const updateHistoryDepth = useCallback(() => {
    setHistoryDepth({ undo: history.current.past.length, redo: history.current.future.length });
  }, []);

  const remember = useCallback((key: string, force = false) => {
    const now = Date.now();
    const grouped = !force && historyGroup.current?.key === key && now - historyGroup.current.at < HISTORY_GROUP_MS;
    historyGroup.current = { key, at: now };
    if (grouped) return;
    history.current.past.push(cloneSnapshot(current.current));
    if (history.current.past.length > HISTORY_LIMIT) history.current.past.shift();
    history.current.future = [];
    updateHistoryDepth();
  }, [updateHistoryDepth]);

  const markDirty = useCallback(() => {
    dirtyVersion.current += 1;
    blockedByConflict.current = false;
    setStatus("Unsaved changes");
  }, []);

  const restoreSnapshot = useCallback((snapshot: EditorSnapshot) => {
    const restored = cloneSnapshot(snapshot);
    current.current = restored;
    setStart(restored.start);
    setRfNodes(restored.nodes);
    setSelectedId(null);
    historyGroup.current = null;
    markDirty();
  }, [markDirty, setRfNodes]);

  const undo = useCallback(() => {
    const previous = history.current.past.pop();
    if (!previous) return;
    history.current.future.push(cloneSnapshot(current.current));
    restoreSnapshot(previous);
    updateHistoryDepth();
  }, [restoreSnapshot, updateHistoryDepth]);

  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(cloneSnapshot(current.current));
    restoreSnapshot(next);
    updateHistoryDepth();
  }, [restoreSnapshot, updateHistoryDepth]);

  const serialiseCurrent = useCallback(() => {
    const nodes: Record<string, FlowNode> = {};
    const positions: Record<string, Pos> = {};
    for (const rn of current.current.nodes) {
      nodes[rn.id] = rn.data.flow;
      positions[rn.id] = rn.position;
    }
    return JSON.stringify({ start: current.current.start, nodes, positions });
  }, []);

  const persistDraft = useCallback(async (manual = false) => {
    if (blockedByConflict.current && !manual) return;
    if (saving.current) {
      saveAgain.current = true;
      return;
    }
    if (!manual && status === "Saved") return;
    saving.current = true;
    saveAgain.current = false;
    const version = dirtyVersion.current;
    const definition = serialiseCurrent();
    setStatus("Saving…");
    try {
      const res = await saveFlow(flowId, definition, savedAt.current);
      if (!res.ok) {
        blockedByConflict.current = true;
        setStatus(res.conflict ? "Not saved — this draft changed elsewhere" : res.error ?? "Save failed");
        if (manual || res.conflict) toast.error(res.error ?? "Flow could not be saved");
        return;
      }
      savedAt.current = res.updatedAt ?? savedAt.current;
      if (dirtyVersion.current === version) {
        setStatus("Saved");
        try { window.localStorage.removeItem(flowStorageKey(flowId)); } catch { /* storage is optional */ }
      } else {
        setStatus("Unsaved changes");
        saveAgain.current = true;
      }
      if (manual) toast.success("Flow saved");
      return true;
    } catch {
      blockedByConflict.current = true;
      setStatus("Save failed — check your connection and try again");
      if (manual) toast.error("Flow could not be saved");
      return false;
    } finally {
      saving.current = false;
      if (saveAgain.current && !blockedByConflict.current) {
        saveAgain.current = false;
        setSaveNonce((value) => value + 1);
      }
    }
  }, [flowId, serialiseCurrent, status]);

  useEffect(() => {
    if (recovered.current) return;
    try {
      const raw = window.localStorage.getItem(flowStorageKey(flowId));
      if (!raw) return;
      const stored = JSON.parse(raw) as { baseUpdatedAt?: string; definition?: string };
      if (stored.baseUpdatedAt !== updatedAt || !stored.definition) return;
      const parsed = JSON.parse(stored.definition) as FlowData;
      if (!parsed.start || !parsed.nodes?.[parsed.start]) return;
      const restoredNodes = Object.values(parsed.nodes).map((node, index) => toRfNode(node, parsed.positions?.[node.id] ?? { x: (index % 4) * 300 + 40, y: Math.floor(index / 4) * 220 + 40 }, node.id === parsed.start));
      const timer = window.setTimeout(() => {
        if (recovered.current) return;
        recovered.current = true;
        history.current.past = [cloneSnapshot(current.current)];
        history.current.future = [];
        updateHistoryDepth();
        setStart(parsed.start);
        setRfNodes(restoredNodes);
        current.current = { start: parsed.start, nodes: restoredNodes };
        dirtyVersion.current += 1;
        setStatus("Recovered unsaved changes");
        toast.info("Recovered unsaved flow changes from this browser");
      }, 0);
      return () => window.clearTimeout(timer);
    } catch {
      try { window.localStorage.removeItem(flowStorageKey(flowId)); } catch { /* storage is optional */ }
    }
  }, [flowId, setRfNodes, updatedAt, updateHistoryDepth]);

  useEffect(() => {
    if (status === "Saved" || status === "Saving…" || blockedByConflict.current) return;
    try {
      window.localStorage.setItem(flowStorageKey(flowId), JSON.stringify({ baseUpdatedAt: savedAt.current, definition: serialiseCurrent() }));
    } catch { /* private browsing and storage policies may refuse local persistence */ }
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => void persistDraft(false), AUTOSAVE_DELAY_MS);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [flowId, persistDraft, rfNodes, saveNonce, serialiseCurrent, start, status]);

  useEffect(() => {
    if (status === "Saved") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const guardLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement) || target.target === "_blank") return;
      const destination = new URL(target.href, window.location.href);
      if (destination.origin !== window.location.origin || destination.href === window.location.href || destination.hash && destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPendingDestination(`${destination.pathname}${destination.search}${destination.hash}`);
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardLink, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardLink, true);
    };
  }, [flowId, status]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "z") return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      if (event.shiftKey) {
        if (!history.current.future.length) return;
        event.preventDefault();
        redo();
      } else {
        if (!history.current.past.length) return;
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [redo, undo]);

  const [fullscreen, setFullscreen] = useState(false);
  // Esc leaves full screen — unless a dialog is open, whose own Esc closes it first. The page behind stops scrolling.
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const focusCanvasNode = useRef<(nodeId: string) => void>(() => {});
  const flowInstance = useRef<ReactFlowInstance<Node<RFData>, Edge> | null>(null);
  // FIND ON THE CANVAS (lib/flowSearch): the Find button or Ctrl+F; a result selects the step and zooms to it.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const jumpTo = (nodeId: string) => { setSelectedId(nodeId); setInspectorOpen(true); window.setTimeout(() => focusCanvasNode.current(nodeId), 0); };
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);
  const [testing, setTesting] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replaySteps, setReplaySteps] = useState<ReplayStep[] | null>(null);
  // The path a replayed conversation took: each step's numbers, and each wire it crossed.
  const replayPath = useMemo(() => {
    if (!replaySteps) return null;
    const visits = new Map<string, number[]>();
    const wires = new Set<string>();
    replaySteps.forEach((s, i) => {
      visits.set(s.nodeId, [...(visits.get(s.nodeId) ?? []), s.order]);
      if (i) wires.add(`${replaySteps[i - 1].nodeId}>${s.nodeId}`);
    });
    return { visits, wires };
  }, [replaySteps]);

  const patch = useCallback((id: string, updater: (n: FlowNode) => FlowNode) => {
    remember(`node:${id}`);
    markDirty();
    setRfNodes((ns) => ns.map((rn) => (rn.id === id ? { ...rn, data: { ...rn.data, flow: updater(rn.data.flow) } } : rn)));
  }, [markDirty, remember, setRfNodes]);

  const onNodesChange = useCallback((changes: NodeChange<Node<RFData>>[]) => {
    applyNodesChange(changes);
    if (changes.some((change) => change.type === "position" && !change.dragging)) markDirty();
    // A group resized (its NodeResizer): the new size is saved on the group itself.
    for (const change of changes) {
      if (change.type !== "dimensions" || change.resizing !== false || !change.dimensions) continue;
      const { width, height } = change.dimensions;
      setRfNodes((ns) => ns.map((rn) => (rn.id === change.id && rn.data.flow.type === "group"
        ? { ...rn, style: { ...rn.style, width, height }, data: { ...rn.data, flow: { ...rn.data.flow, width: Math.round(width), height: Math.round(height) } } }
        : rn)));
      markDirty();
    }
  }, [applyNodesChange, markDirty, setRfNodes]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    const hasSelection = Boolean(selectedId);
    const animateAll = rfNodes.length <= LARGE_FLOW_EDGE_ANIMATION_LIMIT;
    for (const rn of rfNodes) {
      const n = rn.data.flow;
      const add = (handle: string, target?: string, look?: Partial<Edge>) => {
        if (!target || !rfNodes.some((x) => x.id === target)) return;
        const connectedToSelection = !hasSelection || n.id === selectedId || target === selectedId;
        out.push({
          id: `${n.id}:${handle}`,
          source: n.id,
          sourceHandle: handle,
          target,
          animated: connectedToSelection && (animateAll || hasSelection),
          style: { stroke: "#475569", strokeWidth: connectedToSelection ? 2.2 : 1.4, opacity: connectedToSelection ? 1 : 0.32 },
          ...look,
        });
        if (replayPath) {
          const taken = replayPath.wires.has(`${n.id}>${target}`);
          const edge = out[out.length - 1];
          edge.animated = taken;
          edge.style = { ...edge.style, ...(taken ? { stroke: "#fb923c", strokeWidth: 3, opacity: 1 } : { opacity: 0.15 }) };
        }
      };
      if (n.type === "choice") n.options.forEach((o) => add(`opt:${o.id}`, o.next, { label: o.label.slice(0, 24), labelStyle: { fill: "#cbd5e1", fontSize: 10 }, labelBgStyle: { fill: "#0f172a" } }));
      else if (n.type === "condition") {
        add("true", n.trueNext, { label: "Yes", style: { stroke: "#34d399" }, labelStyle: { fill: "#86efac", fontSize: 10 }, labelBgStyle: { fill: "#0f172a" } });
        add("false", n.falseNext, { label: "No", style: { stroke: "#f87171" }, labelStyle: { fill: "#fca5a5", fontSize: 10 }, labelBgStyle: { fill: "#0f172a" } });
      } else if (n.type === "hours") {
        add("open", n.openNext, { label: "Open", style: { stroke: "#34d399" }, labelStyle: { fill: "#86efac", fontSize: 10 }, labelBgStyle: { fill: "#0f172a" } });
        add("closed", n.closedNext, { label: "Closed", style: { stroke: "#94a3b8" }, labelStyle: { fill: "#cbd5e1", fontSize: 10 }, labelBgStyle: { fill: "#0f172a" } });
      } else if (n.type === "switch") {
        n.cases.forEach((item) => add(`case:${item.id}`, item.next, { label: (item.label || item.value).slice(0, 24), labelStyle: { fill: "#f0abfc", fontSize: 10 }, labelBgStyle: { fill: "#0f172a" } }));
        add("default", n.defaultNext, { label: "Default", labelStyle: { fill: "#cbd5e1", fontSize: 10 }, labelBgStyle: { fill: "#0f172a" } });
      } else if (n.type === "ai") add("handoff", n.handoffNext, { label: "handoff", style: { stroke: "#f59e0b" }, labelStyle: { fill: "#fbbf24", fontSize: 10 }, labelBgStyle: { fill: "#0f172a" } });
      else if (n.type !== "handoff" && n.type !== "end") add("out", (n as { next?: string }).next);
      const routed = n as { failureNext?: string; unavailableNext?: string };
      add("failure", routed.failureNext, { label: "fails", style: { stroke: "#f59e0b" }, labelStyle: { fill: "#fbbf24", fontSize: 10 }, labelBgStyle: { fill: "#0f172a" } });
      add("unavailable", routed.unavailableNext, { label: "none available", style: { stroke: "#94a3b8", strokeDasharray: "5 4" }, labelStyle: { fill: "#cbd5e1", fontSize: 10 }, labelBgStyle: { fill: "#0f172a" } });
    }
    return out;
  }, [replayPath, rfNodes, selectedId]);

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
      if (n.type === "hours") {
        if (c.sourceHandle === "open") return { ...n, openNext: c.target! };
        if (c.sourceHandle === "closed") return { ...n, closedNext: c.target! };
      }
      if (n.type === "switch") {
        if (c.sourceHandle === "default") return { ...n, defaultNext: c.target! };
        if (c.sourceHandle!.startsWith("case:")) {
          const cid = c.sourceHandle!.slice(5);
          return { ...n, cases: n.cases.map((item) => (item.id === cid ? { ...item, next: c.target! } : item)) };
        }
      }
      if (n.type === "ai" && c.sourceHandle === "handoff") return { ...n, handoffNext: c.target! };
      if (c.sourceHandle === "failure") return { ...n, failureNext: c.target! } as FlowNode;
      if (c.sourceHandle === "unavailable") return { ...n, unavailableNext: c.target! } as FlowNode;
      return { ...n, next: c.target! } as FlowNode;
    });
  }, [patch]);

  const addNode = useCallback((type: FlowNode["type"], position?: Pos) => {
    remember(`add:${type}`, true);
    const id = newId(type);
    const fallbackPosition = { x: 120 + Math.random() * 200, y: 120 + Math.random() * 200 };
    setRfNodes((ns) => [...ns, toRfNode(blankNode(type, id), position ?? fallbackPosition, false)]);
    setSelectedId(id);
    markDirty();
    setInspectorOpen(true);
  }, [markDirty, remember, setRfNodes]);

  function removeNode(id: string) {
    remember(`remove:${id}`, true);
    setRfNodes((ns) => ns.filter((n) => n.id !== id).map((n) => ({ ...n, data: { ...n.data, flow: clearRefs(n.data.flow, id) } })));
    if (start === id) {
      const nextStart = current.current.nodes.find((node) => node.id !== id)?.id ?? "";
      setStart(nextStart);
    }
    if (selectedId === id) setSelectedId(null);
    markDirty();
  }

  function markStart(id: string) {
    remember(`start:${id}`, true);
    setStart(id);
    setRfNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, isStart: n.id === id } })));
    markDirty();
  }

  function duplicateNode(id: string) {
    const source = rfNodes.find((node) => node.id === id);
    if (!source) return;
    remember(`duplicate:${id}`, true);
    const copy = structuredClone(source.data.flow) as FlowNode;
    const newNodeId = newId(copy.type);
    const duplicated = { ...copy, id: newNodeId } as FlowNode;
    setRfNodes((nodes) => [...nodes, {
      id: newNodeId,
      type: "flowNode",
      position: { x: source.position.x + 40, y: source.position.y + 40 },
      data: { flow: duplicated, isStart: false },
    }]);
    setSelectedId(newNodeId);
    setInspectorOpen(true);
    markDirty();
  }

  async function onSave() {
    if (await persistDraft(true)) router.refresh();
  }

  const selected = rfNodes.find((n) => n.id === selectedId)?.data.flow ?? null;
  const currentFlow = useMemo(() => ({ start, nodes: Object.fromEntries(rfNodes.map((node) => [node.id, node.data.flow])) }), [rfNodes, start]);
  const liveIssues = useMemo(() => validateFlow(currentFlow, channels), [channels, currentFlow]);
  const issuesByNode = useMemo(() => {
    const grouped = new Map<string, FlowIssue[]>();
    for (const issue of liveIssues) {
      if (!issue.nodeId) continue;
      grouped.set(issue.nodeId, [...(grouped.get(issue.nodeId) ?? []), issue]);
    }
    return grouped;
  }, [liveIssues]);
  const displayNodes = useMemo(() => rfNodes.map((node) => {
    const issues = issuesByNode.get(node.id);
    if (!issues && node.id !== selectedId && !replayPath) return node;
    const shown = { ...node, selected: node.id === selectedId, data: issues ? { ...node.data, issues } : node.data };
    return replayPath ? { ...shown, data: { ...shown.data, replay: replayPath.visits.get(node.id) ?? [] } } : shown;
  }), [issuesByNode, replayPath, rfNodes, selectedId]);
  const selectedIssues = selectedId ? issuesByNode.get(selectedId) ?? [] : [];

  const focusIssue = useCallback((issue: FlowIssue) => {
    if (!issue.nodeId || !rfNodes.some((node) => node.id === issue.nodeId)) return;
    setSelectedId(issue.nodeId);
    setInspectorOpen(true);
    window.setTimeout(() => focusCanvasNode.current(issue.nodeId!), 0);
  }, [rfNodes]);
  // Steps only: a note or group can't be a step's next one.
  const nodeOptions = rfNodes.filter((n) => !isAnnotation(n.data.flow)).map((n) => ({ id: n.id, label: `${TYPE_META[n.data.flow.type].label}: ${summary(n.data.flow).slice(0, 24) || n.data.flow.type}` }));
  const knownVariables = useMemo(() => {
    const vars = new Set(BUILTIN_VARIABLES);
    for (const rn of rfNodes) {
      const node = rn.data.flow;
      if ((node.type === "capture" || node.type === "captureFile" || node.type === "set") && node.variable) vars.add(node.variable);
      if ((node.type === "http" || node.type === "knowledge") && node.saveAs) vars.add(node.saveAs);
      if (node.type === "extract") node.fields.forEach((field) => field && vars.add(field));
    }
    return [...vars].sort();
  }, [rfNodes]);
  const currentDraftDefinition = useMemo(() => JSON.stringify({
    start,
    nodes: Object.fromEntries(rfNodes.map((node) => [node.id, node.data.flow])),
    positions: Object.fromEntries(rfNodes.map((node) => [node.id, node.position])),
  }), [rfNodes, start]);

  const filteredGroups = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase();
    return NODE_GROUPS.map((group) => ({
      ...group,
      types: group.types.filter((type) => {
        if (!query) return true;
        const meta = TYPE_META[type];
        return `${meta.label} ${meta.description} ${type}`.toLowerCase().includes(query);
      }),
    })).filter((group) => group.types.length > 0);
  }, [paletteQuery]);

  const onPaletteDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>, type: FlowNode["type"]) => {
    event.dataTransfer.setData("application/x-flowbot-node", type);
    event.dataTransfer.effectAllowed = "copy";
  }, []);

  const onCanvasDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/x-flowbot-node") as FlowNode["type"];
    if (!type || !TYPE_META[type] || !flowInstance.current) return;
    const position = flowInstance.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: true });
    addNode(type, position);
  }, [addNode]);

  return (
    <div className="space-y-4">
      <FlowLintPanel issues={liveIssues} channels={channels} onSelectIssue={focusIssue} live />
      <BuilderWorkspaceShell fullscreen={fullscreen} className="min-h-[720px] md:h-[calc(100dvh-8rem)] md:min-h-0">
        <ConfirmActionDialog
          destructive
          open={pendingDestination !== null}
          onOpenChange={(open) => { if (!open) setPendingDestination(null); }}
          title="Leave with unsaved changes?"
          description="Your latest flow edits have not been saved. Leaving now will discard the browser recovery copy."
          confirmLabel="Leave flow"
          onConfirm={() => {
            const destination = pendingDestination;
            if (!destination) return;
            try { window.localStorage.removeItem(flowStorageKey(flowId)); } catch { /* storage is optional */ }
            setPendingDestination(null);
            router.push(destination);
          }}
        />
        <BuilderWorkspaceBar title="Conversation flow" description="Connect nodes to shape customer conversations and CRM hand-offs." status={<BuilderSaveStatus status={status} />}>
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
          <button type="button" onClick={() => { setTesting(false); setFindOpen((value) => !value); }} className={cn("btn-secondary btn-sm", findOpen && "border-orange-400/40 text-orange-200")} title="Find a step (Ctrl+F)"><Search className="size-4" /><span className="hidden sm:inline">Find</span></button>
          <button type="button" onClick={() => setTesting((value) => !value)} className={cn("btn-secondary btn-sm", testing && "border-orange-400/40 text-orange-200")}><FlaskConical className="size-4" />{testing ? "Back to canvas" : "Test current canvas"}</button>
          <button type="button" onClick={() => { setTesting(false); setReplayOpen((value) => !value); if (replayOpen) setReplaySteps(null); }} className={cn("btn-secondary btn-sm", replayOpen && "border-orange-400/40 text-orange-200")} title="Replay a real conversation on this flow"><History className="size-4" />Replay</button>
          <button type="button" onClick={onSave} className="btn-primary btn-sm"><Save className="size-4" />Save</button>
          <ConfirmActionDialog destructive title="Reset this flow?" description="Every node, connection and unsaved change will be replaced with the default flow." confirmLabel="Reset flow" onConfirm={async () => {
            const res = await resetFlow(flowId, savedAt.current);
            if (!res.ok) {
              setStatus("Not saved — this draft changed elsewhere");
              toast.error(res.error ?? "Could not reset this flow.");
              return;
            }
            savedAt.current = res.updatedAt ?? savedAt.current;
            setStatus("Saved");
            toast.success("Flow reset");
            router.refresh();
          }} trigger={<button type="button" className="btn-secondary btn-sm"><RotateCcwIcon />Reset</button>} />
          {Object.keys(stepNumbers).length > 0 && (
            <button type="button" onClick={() => setShowNumbers((value) => !value)} aria-pressed={showNumbers} className={cn("btn-secondary btn-sm", showNumbers && "ring-1 ring-emerald-400/50")} title={`How many customers reached each step — last ${stepNumbersDays} days`}>
              <BarChart3 className="size-4" /><span className="hidden sm:inline">Numbers</span>
            </button>
          )}
          <button type="button" onClick={() => setFullscreen((value) => !value)} className="btn-secondary btn-sm" title={fullscreen ? "Exit full screen" : "Full screen"}>
            {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}<span className="hidden sm:inline">{fullscreen ? "Exit" : "Full screen"}</span>
          </button>
        </BuilderWorkspaceBar>

        {testing ? (
          <div className="min-h-0 flex-1 overflow-auto bg-[#0b0f0e] p-3">
            <FlowSimulator flowId={flowId} businessName={businessName} draftDefinition={currentDraftDefinition} />
          </div>
        ) : (
          <div className="relative flex min-h-0 flex-1">
            {paletteOpen && (
              <aside className="w-72 shrink-0 overflow-y-auto border-r border-white/[0.08] bg-[#111614] max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-[80] max-lg:max-h-[72dvh] max-lg:w-auto max-lg:rounded-t-3xl max-lg:border-t max-lg:shadow-[0_-24px_70px_rgba(0,0,0,.55)]">
                <div className="sticky top-0 z-10 border-b border-white/[0.08] bg-[#111614]/95 p-3 backdrop-blur">
                  <div className="flex items-center justify-between gap-3 px-1 pb-3">
                    <div><p className="text-sm font-semibold text-white">Node palette</p><p className="text-xs text-slate-400">Drag onto the canvas or click to add</p></div>
                    <button type="button" onClick={() => setPaletteOpen(false)} className="grid size-10 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-4" /><span className="sr-only">Close node palette</span></button>
                  </div>
                  <label className="relative block">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
                    <input value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} className="input h-10 pl-9" placeholder="Search nodes…" aria-label="Search nodes" />
                  </label>
                </div>
                <div className="space-y-5 p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">
                  {filteredGroups.map((group) => (
                    <section key={group.label}>
                      <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500">{group.label}</p>
                      <div className="grid gap-2">
                        {group.types.map((type) => {
                          const meta = TYPE_META[type];
                          const Icon = meta.icon;
                          return (
                            <button key={type} type="button" draggable onDragStart={(event) => onPaletteDragStart(event, type)} onClick={() => addNode(type)} className={cn("group flex min-h-14 items-center gap-3 rounded-xl border bg-white/[0.025] px-3 py-2.5 text-left text-sm text-slate-200 transition hover:-translate-y-px hover:bg-white/[0.055]", meta.tone)}>
                              <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", meta.header)}><Icon className="size-4" /></span>
                              <span className="min-w-0"><span className="block font-medium">{meta.label}</span><span className="mt-0.5 block text-[11px] leading-4 text-slate-500 group-hover:text-slate-400">{meta.description}</span></span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                  {!filteredGroups.length && <div className="rounded-xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">No nodes match “{paletteQuery}”.</div>}
                </div>
              </aside>
            )}

            <main className="min-w-0 flex-1 bg-[#0b0f0e] p-2 sm:p-3">
              <div className="relative h-full min-h-[32rem] overflow-hidden rounded-xl border border-white/[0.08] bg-[#0f1412]" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={onCanvasDrop}>
                {findOpen && (() => {
                  const hits = searchFlow(currentFlow.nodes, findQuery);
                  return (
                    <div className="absolute left-3 top-3 z-20 w-80 max-w-[calc(100%-1.5rem)] rounded-xl border border-white/10 bg-[#111614]/95 p-2 shadow-2xl backdrop-blur">
                      <div className="flex items-center gap-2">
                        <Search className="size-4 shrink-0 text-slate-400" />
                        <input
                          autoFocus
                          className="input h-9 flex-1"
                          aria-label="Find a step"
                          placeholder="Find a step — e.g. brochure, price"
                          value={findQuery}
                          onChange={(e) => setFindQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setFindOpen(false);
                            if (e.key === "Enter" && hits[0]) jumpTo(hits[0].nodeId);
                          }}
                        />
                        <button type="button" onClick={() => setFindOpen(false)} className="grid size-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-4" /><span className="sr-only">Close find</span></button>
                      </div>
                      {findQuery.trim() && (
                        <div className="mt-2 max-h-72 overflow-y-auto">
                          {hits.length === 0 ? <p className="px-2 py-1.5 text-xs text-slate-400">No step mentions “{findQuery.trim()}”.</p> : hits.map((hit) => (
                            <button key={hit.nodeId} type="button" onClick={() => jumpTo(hit.nodeId)} className={cn("block w-full rounded-lg px-2 py-1.5 text-left hover:bg-white/5", selectedId === hit.nodeId && "bg-orange-500/10")}>
                              <span className="block truncate text-xs font-medium text-slate-100">{hit.label}</span>
                              <span className="block truncate text-[11px] text-slate-400">{hit.snippet}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <StepNumbersContext.Provider value={showNumbers ? stepNumbers : null}>
                <ReactFlow
                  deleteKeyCode={null}
                  nodes={displayNodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onInit={(instance) => {
                    flowInstance.current = instance;
                    focusCanvasNode.current = (nodeId) => { void instance.fitView({ nodes: [{ id: nodeId }], duration: 250, maxZoom: 1.35, padding: 0.45 }); };
                  }}
                  onNodesChange={onNodesChange}
                  onNodeDragStart={(_, node) => remember(`drag:${node.id}`, true)}
                  onNodeClick={(_, node) => { setSelectedId(node.id); setInspectorOpen(true); }}
                  onNodeContextMenu={(event, node) => { event.preventDefault(); setSelectedId(node.id); setInspectorOpen(true); }}
                  onConnect={onConnect}
                  onPaneClick={() => setSelectedId(null)}
                  fitView
                  snapToGrid
                  snapGrid={[GRID_SIZE, GRID_SIZE]}
                  minZoom={0.2}
                  maxZoom={1.8}
                  selectionOnDrag
                  proOptions={{ hideAttribution: true }}
                >
                  <Background color="#25312d" gap={GRID_SIZE} size={1} />
                  {/* Targeting the library's own control-button CLASS does not
                      work here: Tailwind turns underscores inside an arbitrary
                      value into spaces, so that selector compiles to an element
                      type that does not exist, and matches nothing. `[&_button]`
                      has no underscores to mangle, and the controls container
                      holds only these buttons. Guard: tests/darkThemeControls. */}
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
                  <Panel position="top-right" className="!m-3 hidden sm:block">
                    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#111614]/90 px-2.5 py-1.5 text-[11px] text-slate-400 shadow-lg backdrop-blur">
                      <MousePointer2 className="size-3.5" />Drag nodes · connect handles · select to inspect
                    </div>
                  </Panel>
                </ReactFlow>
                </StepNumbersContext.Provider>
                {rfNodes.length === 0 && (
                  <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
                    <div className="pointer-events-auto max-w-sm rounded-2xl border border-dashed border-white/15 bg-[#111614]/95 p-6 text-center shadow-2xl">
                      <Workflow className="mx-auto size-7 text-primary" />
                      <p className="mt-3 font-semibold text-white">Build your first conversation step</p>
                      <p className="mt-1 text-sm leading-6 text-slate-400">Open Nodes, then drag a Message, Menu or AI step onto the canvas. Connect the output handle to the next step.</p>
                      <button type="button" onClick={() => setPaletteOpen(true)} className="btn-primary btn-sm mt-4">Open node palette</button>
                    </div>
                  </div>
                )}
              </div>
            </main>

            {inspectorOpen && (
              <aside className="w-80 shrink-0 overflow-y-auto border-l border-white/[0.08] bg-[#111614] max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-[81] max-lg:max-h-[78dvh] max-lg:w-auto max-lg:rounded-t-3xl max-lg:border-t max-lg:shadow-[0_-24px_70px_rgba(0,0,0,.55)]">
                <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.08] bg-[#111614]/95 px-4 py-3 backdrop-blur"><div><p className="text-sm font-semibold text-white">Inspector</p><p className="text-xs text-slate-400">Configure the selected node</p></div><button type="button" onClick={() => setInspectorOpen(false)} className="grid size-10 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-4" /><span className="sr-only">Close inspector</span></button></div>
                <div className="space-y-5 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                  {!selected ? <p className="text-sm leading-6 text-slate-400">Select a node to edit it. Drag from a node&apos;s output handle to another node to create a connection.</p> : <><NodeIssues issues={selectedIssues} /><NodePanel key={selected.id} node={selected} isStart={selected.id === start} nodeOptions={nodeOptions.filter((option) => option.id !== selected.id)} variables={knownVariables} journeys={journeys} flows={flows} documents={documents} staff={staff} connections={connections} crmTags={crmTags} stages={stages} onChange={(next) => patch(selected.id, () => next)} onDelete={() => removeNode(selected.id)} onDuplicate={() => duplicateNode(selected.id)} onMakeStart={() => markStart(selected.id)} /></>}
                  <VariablesPanel variables={knownVariables} />
                </div>
              </aside>
            )}
            {replayOpen && (
              <FlowReplayPanel
                flowId={flowId}
                nodeLabel={(nodeId) => { const n = rfNodes.find((x) => x.id === nodeId)?.data.flow; return n ? `${TYPE_META[n.type].label}${summary(n) ? ` — ${summary(n).slice(0, 40)}` : ""}` : null; }}
                onSteps={setReplaySteps}
                onFocus={(nodeId) => focusCanvasNode.current(nodeId)}
                onClose={() => { setReplayOpen(false); setReplaySteps(null); }}
              />
            )}
          </div>
        )}
      </BuilderWorkspaceShell>
    </div>
  );
}

function NodeIssues({ issues }: { issues: FlowIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.025] p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Checks for this node</p>
      {issues.map((issue, index) => <p key={`${issue.code}-${issue.channel ?? "all"}-${index}`} className={cn("text-xs leading-5", issue.severity === "error" ? "text-red-300" : "text-amber-300")}>{issue.message}{issue.channel ? <span className="block text-[10px] uppercase tracking-wide text-slate-500">{issue.channel}</span> : null}</p>)}
    </div>
  );
}

function RotateCcwIcon() { return <RotateCcw className="size-4" />; }

function clearRefs(n: FlowNode, removedId: string): FlowNode {
  if (n.type === "choice") return { ...n, options: n.options.map((o) => (o.next === removedId ? { ...o, next: undefined } : o)) };
  if (n.type === "condition") return { ...n, trueNext: n.trueNext === removedId ? undefined : n.trueNext, falseNext: n.falseNext === removedId ? undefined : n.falseNext };
  if (n.type === "switch") return { ...n, cases: n.cases.map((item) => (item.next === removedId ? { ...item, next: undefined } : item)), defaultNext: n.defaultNext === removedId ? undefined : n.defaultNext };
  if (n.type === "ai") return n.handoffNext === removedId ? { ...n, handoffNext: undefined } : n;
  if (n.type === "hours") return { ...n, openNext: n.openNext === removedId ? undefined : n.openNext, closedNext: n.closedNext === removedId ? undefined : n.closedNext };
  if (n.type === "goto") return n.target === removedId ? { ...n, target: "", targetLabel: undefined } : n;
  const routed = n as { next?: string; failureNext?: string; unavailableNext?: string };
  const cleared: Record<string, undefined> = {};
  if (routed.next === removedId) cleared.next = undefined;
  if (routed.failureNext === removedId) cleared.failureNext = undefined;
  if (routed.unavailableNext === removedId) cleared.unavailableNext = undefined;
  return Object.keys(cleared).length ? ({ ...n, ...cleared } as FlowNode) : n;
}

const FALLIBLE = new Set(["booking", "slots", "journey", "http", "knowledge", "extract", "subflow", "crm"]);

function AnnotationColorPicker({ value, onChange }: { value: AnnotationColor; onChange: (color: AnnotationColor) => void }) {
  return (
    <div>
      <p className="label">Colour</p>
      <div className="flex gap-1.5">
        {(Object.keys(ANNOTATION_COLORS) as AnnotationColor[]).map((color) => (
          <button key={color} type="button" onClick={() => onChange(color)} aria-label={color} aria-pressed={value === color}
            className={cn("size-7 rounded-md border-2", ANNOTATION_COLORS[color].box, value === color ? "ring-2 ring-white/60" : "")} />
        ))}
      </div>
    </div>
  );
}

function TargetPicker({ value, onPick, nodeOptions }: { value?: string; onPick: (value?: string) => void; nodeOptions: { id: string; label: string }[] }) {
  return <select className="input btn-sm" value={value ?? ""} onChange={(event) => onPick(event.target.value || undefined)}><option value="">— (ends here) —</option>{nodeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>;
}

function VariablesPanel({ variables }: { variables: string[] }) {
  return (
    <div className="border-t border-white/8 pt-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Variables</p>
      <p className="mt-1 text-xs text-slate-500">Use these in messages as <code>{"{{variable}}"}</code> or in a Condition, Switch or action node.</p>
      <div className="mt-2 flex flex-wrap gap-1.5">{variables.map((variable) => <code key={variable} className="rounded-md border border-white/8 bg-white/[0.035] px-1.5 py-1 text-[11px] text-slate-300">{`{{${variable}}}`}</code>)}</div>
    </div>
  );
}

function NodePanel({ node, isStart, nodeOptions, variables, journeys, flows, documents = [], staff = [], connections = [], crmTags = [], stages = [], onChange, onDelete, onDuplicate, onMakeStart }: { connections?: { id: string; name: string; host: string }[]; crmTags?: string[]; stages?: { id: string; name: string }[]; node: FlowNode; isStart: boolean; nodeOptions: { id: string; label: string }[]; variables: string[]; journeys: FlowJourneyOption[]; flows: FlowOptionRef[]; documents?: { id: string; name: string }[]; staff?: { id: string; name: string }[]; onChange: (n: FlowNode) => void; onDelete: () => void; onDuplicate: () => void; onMakeStart: () => void }) {
  const meta = TYPE_META[node.type];
  const Icon = meta.icon;
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4 text-primary" />{meta.label}</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onDuplicate} className="grid size-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white" title="Duplicate node"><Copy className="size-4" /><span className="sr-only">Duplicate node</span></button>
          {!isStart && !isAnnotation(node) && <button type="button" onClick={onMakeStart} className="min-h-9 rounded-lg px-2 text-xs text-orange-400 hover:bg-orange-500/10">Set start</button>}
        </div>
      </div>

      {(node.type === "message" || node.type === "handoff") && <div><div className="flex items-center justify-between"><label className="label" htmlFor={`msg-${node.id}`}>Message</label><EmojiButton targetId={`msg-${node.id}`} value={node.text ?? ""} onChange={(text) => onChange({ ...node, text })} /></div><textarea id={`msg-${node.id}`} className="input" rows={4} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div>}
      {node.type === "handoff" && <><div><label className="label">Handoff reason</label><input className="input" value={node.reason ?? ""} onChange={(e) => onChange({ ...node, reason: e.target.value || undefined })} placeholder="Sales enquiry" /></div><div><label className="label">Staff summary</label><textarea className="input" rows={3} value={node.summary ?? ""} onChange={(e) => onChange({ ...node, summary: e.target.value || undefined })} placeholder="Include {{variables}} collected by the flow" /><p className="mt-1 text-xs text-slate-500">The live conversation lands in the Inbox; this controls why, and with what context, it is handed over.</p></div></>}
      {node.type === "capture" && <><div><div className="flex items-center justify-between"><label className="label" htmlFor={`ask-${node.id}`}>Question to ask</label><EmojiButton targetId={`ask-${node.id}`} value={node.text} onChange={(text) => onChange({ ...node, text })} /></div><textarea id={`ask-${node.id}`} className="input" rows={3} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div><div className="grid grid-cols-2 gap-2"><div><label className="label">Save as</label><input className="input" value={node.variable} onChange={(e) => onChange({ ...node, variable: e.target.value.replace(/\W/g, "") })} placeholder="name" /></div><div><label className="label">Type</label><select className="input" value={node.format ?? "text"} onChange={(e) => onChange({ ...node, format: e.target.value === "text" ? undefined : (e.target.value as "email" | "phone" | "number" | "date") })}><option value="text">Text</option><option value="email">Email</option><option value="phone">Phone</option><option value="number">Number</option><option value="date">Date</option></select></div></div><p className="text-xs text-slate-500">Use it later as <code>{`{{${node.variable || "name"}}}`}</code>. Name / phone / email feed the CRM action &amp; booking.</p></>}
      {node.type === "captureFile" && <><div><label className="label">What to ask for</label><textarea className="input" rows={2} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} placeholder="Please send a photo of the cart" /></div><div><label className="label">Save file as</label><input className="input" value={node.variable} onChange={(e) => onChange({ ...node, variable: e.target.value.replace(/\W/g, "") })} placeholder="photo" /><p className="mt-1 text-xs text-slate-500">The uploaded file is saved and linked on the lead/booking.</p></div></>}
      {node.type === "image" && <><div><label className="label">Image</label><input className="input" value={node.url} onChange={(e) => onChange({ ...node, url: e.target.value })} placeholder="Paste an image URL, or upload →" /><label className="btn-secondary btn-sm mt-1.5 inline-flex cursor-pointer"><Upload className="size-3.5" /> Upload<input type="file" accept="image/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; const fd = new FormData(); fd.set("file", f); const url = await uploadCampaignImage(fd); if (url) onChange({ ...node, url }); }} /></label></div>{node.url && <img src={node.url} alt="" className="max-h-32 rounded-lg border border-slate-800" />}<div><label className="label">Caption (optional)</label><input className="input" value={node.caption ?? ""} onChange={(e) => onChange({ ...node, caption: e.target.value })} /></div></>}
      {node.type === "slots" && <><div><label className="label">Slot action</label><select className="input" value={node.action ?? "book"} onChange={(e) => onChange({ ...node, action: e.target.value as SlotAction })}><option value="book">Book a new service slot</option><option value="reschedule">Move {"{{booking_id}}"} to a new slot</option></select></div><div><label className="label">Prompt</label><textarea className="input" rows={2} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div><div><label className="label">If nothing&apos;s open</label><textarea className="input" rows={2} value={node.noneText ?? ""} onChange={(e) => onChange({ ...node, noneText: e.target.value })} /></div><p className="text-xs text-slate-500">{node.action === "reschedule" ? <>Atomically moves the existing customer-owned booking in <code>{"{{booking_id}}"}</code>. Put a Booking lookup node first.</> : <>Shows real open workshop slots and reserves the chosen one. The time lands in <code>{"{{slot}}"}</code>.</>}</p></>}
      {node.type === "answer" && <><div><label className="label">Answer type</label><select className="input" value={node.answerSource ?? "static"} onChange={(e) => { const v = e.target.value; onChange(v === "static" ? { ...node, answerSource: undefined, text: node.text ?? "" } : { ...node, answerSource: v as "pricelist" | "colours", text: undefined }); }}><option value="static">Custom text</option><option value="pricelist">Price list (from products)</option><option value="colours">Colours (from products)</option></select></div>{!node.answerSource && <div><label className="label">Text</label><textarea className="input" rows={4} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div>}</>}
      {node.type === "condition" && <><div><label className="label">Variable</label><input className="input" list={`flow-vars-${node.id}`} value={node.condition.variable} onChange={(e) => onChange({ ...node, condition: { ...node.condition, variable: e.target.value.replace(/\W/g, "") } })} placeholder="model" /><datalist id={`flow-vars-${node.id}`}>{variables.map((variable) => <option key={variable} value={variable} />)}</datalist></div><div><label className="label">Rule</label><select className="input" value={node.condition.operator} onChange={(e) => onChange({ ...node, condition: { ...node.condition, operator: e.target.value as ConditionOperator } })}><option value="equals">Equals</option><option value="not_equals">Does not equal</option><option value="contains">Contains</option><option value="exists">Has a value</option><option value="empty">Is empty</option></select></div>{!["exists", "empty"].includes(node.condition.operator) && <div><label className="label">Value</label><input className="input" value={node.condition.value ?? ""} onChange={(e) => onChange({ ...node, condition: { ...node.condition, value: e.target.value } })} placeholder="Rover XL" /></div>}<div className="grid grid-cols-2 gap-2"><div><label className="label text-emerald-300">Yes →</label><TargetPicker nodeOptions={nodeOptions} value={node.trueNext} onPick={(v) => onChange({ ...node, trueNext: v })} /></div><div><label className="label text-red-300">No →</label><TargetPicker nodeOptions={nodeOptions} value={node.falseNext} onPick={(v) => onChange({ ...node, falseNext: v })} /></div></div><p className="text-xs text-slate-500">Conditions are deterministic and never call AI. Text comparisons are case-insensitive.</p></>}
      {node.type === "ai" && <p className="text-xs text-slate-400">Chats conversationally, grounded in approved CRM/product facts and Approved Knowledge. Connect the amber dot to a node to control where it goes when confidence requires a handoff (otherwise it notifies the team).</p>}
      {node.type === "booking" && <><div><label className="label">Action</label><select className="input" value={node.action ?? "service"} onChange={(e) => onChange({ ...node, action: e.target.value as BookingAction })}><option value="service">Create service request</option><option value="demo">Create demo / test-drive lead</option><option value="lead">Create lead / enquiry</option><option value="lookup">Find customer&apos;s next service booking</option><option value="cancel">Cancel {"{{booking_id}}"}</option></select><p className="mt-1 text-xs text-slate-500">{node.action === "lookup" ? <>Read-only. Sets <code>{"{{booking_identity}}"}</code> (verified | unverified) and <code>{"{{booking_found}}"}</code>, <code>{"{{booking_id}}"}</code>, <code>{"{{booking_slot}}"}</code> and <code>{"{{booking_summary}}"}</code> from an existing customer record.</> : node.action === "cancel" ? <>Cancels only the future customer-owned booking in <code>{"{{booking_id}}"}</code> and retains its Activity history.</> : <>Built from captured fields (name, phone, email, service, model). For a real dated service booking use Workshop slots.</>}</p></div><div><label className="label">Message after action (optional)</label><textarea className="input" rows={3} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div></>}
      {node.type === "hours" && <><p className="text-xs text-slate-400">Sends the customer down <strong className="text-emerald-300">Open</strong> or <strong className="text-slate-200">Closed</strong> by your office hours (Chatbot page) — e.g. closed: “We&apos;re closed — the team will reply from 8am”. Stores <code>{"{{open_now}}"}</code> as yes / no.</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={node.holidaysClosed !== false} onChange={(e) => onChange({ ...node, holidaysClosed: e.target.checked })} className="h-4 w-4" /> Closed on public holidays and your closed days</label><p className="text-xs text-slate-500">Your country&apos;s holidays and your own closed days are in <a href="/settings/public-holidays" className="underline" target="_blank" rel="noreferrer">Settings → Public holidays</a>.</p></>}
      {node.type === "goto" && <><div><label className="label" htmlFor={`goto-${node.id}`}>Jump to</label><select id={`goto-${node.id}`} className="input" value={node.target} onChange={(e) => { const option = nodeOptions.find((o) => o.id === e.target.value); onChange({ ...node, target: e.target.value, targetLabel: option?.label }); }}><option value="">Choose a step…</option>{nodeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></div><p className="text-xs text-slate-500">Jumps straight to that step and sends nothing itself — no wire across the canvas. For “↩ Back to menu”, point a menu option at a Go to placed next to it, jumping to your menu.</p></>}
      {node.type === "note" && <><div><label className="label" htmlFor={`note-${node.id}`}>Note</label><textarea id={`note-${node.id}`} className="input" rows={5} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} placeholder="Brochure section — update each quarter" /></div><AnnotationColorPicker value={node.color ?? "yellow"} onChange={(color) => onChange({ ...node, color })} /><p className="text-xs text-slate-500">For the team only — never sent to a customer.</p></>}
      {node.type === "group" && <><div><label className="label" htmlFor={`group-${node.id}`}>Title</label><input id={`group-${node.id}`} className="input" value={node.label} maxLength={60} onChange={(e) => onChange({ ...node, label: e.target.value })} placeholder="Welcome" /></div><AnnotationColorPicker value={node.color ?? "blue"} onChange={(color) => onChange({ ...node, color })} /><p className="text-xs text-slate-500">A box behind the steps to frame a section. Drag its corners to resize it; moving it doesn&apos;t move the steps inside.</p></>}
      {node.type === "crm" && <>
        <div><label className="label" htmlFor={`crm-action-${node.id}`}>Change</label><select id={`crm-action-${node.id}`} className="input" value={node.action} onChange={(e) => onChange({ id: node.id, type: "crm", action: e.target.value as CrmUpdateAction, text: node.text, failureText: node.failureText, next: node.next, failureNext: node.failureNext })}><option value="tag">Tag the customer</option><option value="assign">Set their salesperson</option><option value="stage">Move their open deal to a stage</option></select></div>
        {node.action === "tag" && <div><label className="label" htmlFor={`crm-tag-${node.id}`}>Tag</label><input id={`crm-tag-${node.id}`} className="input" list={`crm-tags-${node.id}`} maxLength={40} value={node.tagName ?? ""} onChange={(e) => onChange({ ...node, tagName: e.target.value })} placeholder="QR: Showroom poster" /><datalist id={`crm-tags-${node.id}`}>{crmTags.map((t) => <option key={t} value={t} />)}</datalist><p className="mt-1 text-xs text-slate-500">One of your tags, or a new one — it is created the first time.</p></div>}
        {node.action === "assign" && <div><label className="label" htmlFor={`crm-user-${node.id}`}>Salesperson</label><select id={`crm-user-${node.id}`} className="input" value={node.userId ?? ""} onChange={(e) => onChange({ ...node, userId: e.target.value || undefined, userLabel: staff.find((s) => s.id === e.target.value)?.name })}><option value="">Choose…</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><p className="mt-1 text-xs text-slate-500">Becomes the customer&apos;s owner, and their open deal&apos;s salesperson.</p></div>}
        {node.action === "stage" && <div><label className="label" htmlFor={`crm-stage-${node.id}`}>Stage</label><select id={`crm-stage-${node.id}`} className="input" value={node.stageId ?? ""} onChange={(e) => onChange({ ...node, stageId: e.target.value || undefined, stageLabel: stages.find((s) => s.id === e.target.value)?.name })}><option value="">Choose…</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><p className="mt-1 text-xs text-slate-500">Moves the customer&apos;s one open deal. No open deal, or more than one, takes the “If it fails” exit — it never guesses which.</p></div>}
        <div><label className="label">Message after the change (optional)</label><textarea className="input" rows={2} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value || undefined })} /></div>
        <p className="text-xs text-slate-500">Nothing is said to the customer about it unless you write a message. Recorded in the customer&apos;s history as done by the chatbot.</p>
      </>}
      {node.type === "journey" && <><div><label className="label">Journey</label><select className="input" value={node.journeyId} onChange={(e) => onChange({ ...node, journeyId: e.target.value })}><option value="">Select an active Journey…</option>{journeys.map((journey) => <option key={journey.id} value={journey.id}>{journey.name}</option>)}</select><p className="mt-1 text-xs text-slate-500">Enrols exactly this existing CRM customer/lead in the selected active Journey. Flow continues immediately; waits and later lifecycle actions stay in Journey. Retries reuse the same event identity.</p></div><div><label className="label">Journey starts</label><div className="grid grid-cols-[1fr_1fr] gap-2"><select className="input" aria-label="Journey starts" value={node.after ? "later" : "now"} onChange={(e) => onChange(e.target.value === "later" ? { ...node, after: { amount: 1, unit: "days" } } : { ...node, after: undefined })}><option value="now">Straight away</option><option value="later">As a follow-up, after…</option></select>{node.after && <div className="grid grid-cols-2 gap-2"><input className="input" type="number" min={1} aria-label="Follow up after" value={node.after.amount} onChange={(e) => onChange({ ...node, after: { ...node.after!, amount: Math.max(1, Number(e.target.value) || 1) } })} /><select className="input" aria-label="Unit" value={node.after.unit} onChange={(e) => onChange({ ...node, after: { ...node.after!, unit: e.target.value as "minutes" | "hours" | "days" } })}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select></div>}</div><p className="mt-1 text-xs text-slate-500">A follow-up: the Journey&apos;s first step is due that much later (up to 30 days). The Journey does the waiting — and what it sends is whatever its own steps say.</p></div>{variables.length > 0 && <div><label className="label">Hand these answers to the Journey</label><div className="grid grid-cols-2 gap-1">{variables.map((name) => <label key={name} className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={(node.handOver ?? []).includes(name)} onChange={(e) => onChange({ ...node, handOver: e.target.checked ? [...(node.handOver ?? []), name] : (node.handOver ?? []).filter((n) => n !== name) })} />{name}</label>)}</div><p className="mt-1 text-xs text-slate-500">Each one reaches the Journey as a variable — {"{{var_name}}"} in its messages, or “A journey variable” in its conditions. Up to 10.</p></div>}<div><label className="label">Message after enrolment (optional)</label><textarea className="input" rows={3} value={node.text ?? ""} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div></>}
      {node.type === "knowledge" && <><div><label className="label">Knowledge query (optional)</label><textarea className="input" rows={3} value={node.query} onChange={(e) => onChange({ ...node, query: e.target.value })} placeholder="Leave blank to use the customer's current message" /><p className="mt-1 text-xs text-slate-500">Only approved, currently-valid Flowbot Knowledge entries can be returned.</p></div><div><label className="label">Also save answer as</label><input className="input" value={node.saveAs ?? ""} onChange={(e) => onChange({ ...node, saveAs: e.target.value.replace(/\W/g, "") || undefined })} placeholder="knowledge_answer" /></div><div><label className="label">If nothing matches, say</label><textarea className="input" rows={2} value={node.noMatchText ?? ""} onChange={(e) => onChange({ ...node, noMatchText: e.target.value || undefined })} /></div></>}
      {node.type === "set" && <><div><label className="label">Variable</label><input className="input" value={node.variable} onChange={(e) => onChange({ ...node, variable: e.target.value.replace(/\W/g, "") })} placeholder="status" /></div><div><label className="label">Value</label><textarea className="input" rows={3} value={node.value} onChange={(e) => onChange({ ...node, value: e.target.value })} placeholder="Use {{variables}} if needed" /></div></>}
      {node.type === "switch" && <><div><label className="label">Variable</label><input className="input" list={`flow-vars-${node.id}`} value={node.variable} onChange={(e) => onChange({ ...node, variable: e.target.value.replace(/\W/g, "") })} placeholder="intent" /><datalist id={`flow-vars-${node.id}`}>{variables.map((variable) => <option key={variable} value={variable} />)}</datalist></div><div className="space-y-2"><label className="label">Cases</label>{node.cases.map((item) => <div key={item.id} className="rounded-lg border border-slate-800 p-2"><div className="flex gap-1.5"><input className="input btn-sm flex-1" value={item.value} onChange={(e) => onChange({ ...node, cases: node.cases.map((x) => x.id === item.id ? { ...x, value: e.target.value } : x) })} placeholder="Value" /><button type="button" onClick={() => onChange({ ...node, cases: node.cases.filter((x) => x.id !== item.id) })} className="px-1 text-muted-foreground hover:text-red-400"><X className="size-4" /><span className="sr-only">Remove case</span></button></div><div className="mt-1.5"><TargetPicker nodeOptions={nodeOptions} value={item.next} onPick={(v) => onChange({ ...node, cases: node.cases.map((x) => x.id === item.id ? { ...x, next: v } : x) })} /></div></div>)}<button type="button" className="btn-secondary btn-sm w-full" onClick={() => onChange({ ...node, cases: [...node.cases, { id: `c${Date.now().toString(36)}`, value: "" }] })}>+ Add case</button><div><label className="label">Default →</label><TargetPicker nodeOptions={nodeOptions} value={node.defaultNext} onPick={(v) => onChange({ ...node, defaultNext: v })} /></div></div><p className="text-xs text-slate-500">Matching is exact and case-insensitive. Anything unmatched follows Default.</p></>}
      {node.type === "http" && <><div className="grid grid-cols-[90px_1fr] gap-2"><div><label className="label">Method</label><select className="input" value={node.method} onChange={(e) => onChange({ ...node, method: e.target.value as FlowHttpMethod })}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => <option key={method}>{method}</option>)}</select></div><div><label className="label">HTTPS URL</label><input className="input" value={node.url} onChange={(e) => onChange({ ...node, url: e.target.value })} placeholder="https://api.example.com/…" /></div></div><div><label className="label" htmlFor={`http-conn-${node.id}`}>Connection (API key)</label><select id={`http-conn-${node.id}`} className="input" value={node.connectionId ?? ""} onChange={(e) => onChange({ ...node, connectionId: e.target.value || undefined, connectionName: connections.find((c) => c.id === e.target.value)?.name })}><option value="">None</option>{connections.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.host}</option>)}</select><p className="mt-1 text-xs text-slate-500">Keys live in <a href="/bot-builder/connections" className="underline" target="_blank" rel="noreferrer">Flows → Connections</a>, encrypted and sent only to their own address — never type a key into the headers below.</p></div><div><label className="label">Headers (JSON)</label><textarea className="input font-mono text-xs" rows={3} value={node.headers ?? ""} onChange={(e) => onChange({ ...node, headers: e.target.value || undefined })} placeholder={'{"Accept":"application/json"}'} /></div>{node.method !== "GET" && node.method !== "DELETE" && <div><label className="label">Body</label><textarea className="input font-mono text-xs" rows={4} value={node.body ?? ""} onChange={(e) => onChange({ ...node, body: e.target.value || undefined })} placeholder={'{"customer":"{{name}}"}'} /></div>}<div><label className="label">Save response as</label><input className="input" value={node.saveAs ?? ""} onChange={(e) => onChange({ ...node, saveAs: e.target.value.replace(/\W/g, "") || undefined })} placeholder="api_response" /></div><p className="text-xs text-slate-500">HTTPS only; redirects, local/private addresses and oversized responses are blocked by the runtime.</p></>}
      {node.type === "extract" && <><div><label className="label">What to extract</label><textarea className="input" rows={3} value={node.instruction} onChange={(e) => onChange({ ...node, instruction: e.target.value })} /></div><div><label className="label">Source variable (optional)</label><input className="input" list={`flow-vars-${node.id}`} value={node.sourceVariable ?? ""} onChange={(e) => onChange({ ...node, sourceVariable: e.target.value.replace(/\W/g, "") || undefined })} placeholder="Blank = current customer message" /><datalist id={`flow-vars-${node.id}`}>{variables.map((variable) => <option key={variable} value={variable} />)}</datalist></div><div><label className="label">Output fields</label><input className="input" value={node.fields.join(", ")} onChange={(e) => onChange({ ...node, fields: e.target.value.split(",").map((v) => v.trim().replace(/\W/g, "")).filter(Boolean).slice(0, 12) })} placeholder="name, city, vehicle_interest" /></div><p className="text-xs text-slate-500">The model may only return these named fields and is instructed never to invent missing values.</p></>}
      {node.type === "delay" && <><div><label className="label">Wait (seconds)</label><input className="input" type="number" min={1} max={604800} value={node.seconds} onChange={(e) => onChange({ ...node, seconds: Number(e.target.value) })} /></div><p className="text-xs text-slate-500">A QUIET HOLD, not a scheduled follow-up: the bot stays silent, and the flow resumes with the customer&apos;s next message after the time has passed. Nothing is sent when the timer expires — for a timed follow-up, use a Journey. Maximum: 7 days.</p></>}
      {node.type === "subflow" && <><div><label className="label">Published flow</label><select className="input" value={node.flowId} onChange={(e) => onChange({ ...node, flowId: e.target.value })}><option value="">Choose a reusable flow…</option>{flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}</select></div><p className="text-xs text-slate-500">When you publish this flow, it locks in the subflow&apos;s newest published version — publishing the subflow again later doesn&apos;t change this flow until you publish this one again. Synchronous only: a child that stops to wait for customer input follows the failure route instead.</p></>}
      {node.type === "choice" && <div className="space-y-2"><div><div className="flex items-center justify-between"><label className="label" htmlFor={`prompt-${node.id}`}>Prompt</label><EmojiButton targetId={`prompt-${node.id}`} value={node.text} onChange={(text) => onChange({ ...node, text })} /></div><textarea id={`prompt-${node.id}`} className="input" rows={2} value={node.text} onChange={(e) => onChange({ ...node, text: e.target.value })} /></div><label className="label">Options</label>{node.options.map((o, i) => <div key={o.id} className="space-y-1.5 rounded-lg border border-slate-800 p-2"><div className="flex gap-1.5"><input className="input btn-sm flex-1" value={o.label} onChange={(e) => onChange({ ...node, options: node.options.map((x) => x.id === o.id ? { ...x, label: e.target.value } : x) })} /><button onClick={() => onChange({ ...node, options: node.options.filter((x) => x.id !== o.id) })} className="px-1 text-muted-foreground hover:text-red-400"><X className="size-4" /><span className="sr-only">Remove option</span></button></div><TargetPicker nodeOptions={nodeOptions} value={o.next} onPick={(v) => onChange({ ...node, options: node.options.map((x) => x.id === o.id ? { ...x, next: v } : x) })} />{i === 2 && node.options.length > 3 && <p className="text-[10px] text-amber-400">WhatsApp shows &gt;3 options as a list.</p>}</div>)}<button onClick={() => onChange({ ...node, options: [...node.options, { id: `o${Date.now().toString(36)}`, label: `Option ${node.options.length + 1}` }] })} className="btn-secondary btn-sm w-full">+ Add option</button></div>}

      {node.type === "document" && <><div><label className="label" htmlFor={`doc-${node.id}`}>File to send</label><select id={`doc-${node.id}`} className="input" value={node.documentId} onChange={(e) => { const doc = documents.find((d) => d.id === e.target.value); onChange({ ...node, documentId: e.target.value, ...(doc ? { fileName: doc.name } : { fileName: undefined }) }); }}><option value="">{documents.length ? "Choose a file…" : "No files yet — add them under Documents → Library"}</option>{documents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div><div><div className="flex items-center justify-between"><label className="label" htmlFor={`doc-cap-${node.id}`}>Caption (optional)</label><EmojiButton targetId={`doc-cap-${node.id}`} value={node.caption ?? ""} onChange={(caption) => onChange({ ...node, caption: caption || undefined })} /></div><input id={`doc-cap-${node.id}`} className="input" value={node.caption ?? ""} onChange={(e) => onChange({ ...node, caption: e.target.value || undefined })} placeholder="Here's our brochure, {{name}}" /></div><p className="text-xs text-slate-500">Your Library (brochures, price lists — the newest version is always sent) and general files. Files filed on a customer, vehicle, job card or quote are never offered: they are that customer&apos;s records.</p></>}
      {node.type === "contactCard" && <><div><label className="label" htmlFor={`card-${node.id}`}>Whose card</label><select id={`card-${node.id}`} className="input" value={node.staffUserId ?? ""} onChange={(e) => onChange({ ...node, staffUserId: e.target.value || undefined })}><option value="">The business (Settings → Company)</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div><p className="text-xs text-slate-500">On WhatsApp it arrives as a contact they can save in one tap; elsewhere as text.</p></>}
      {(["message", "answer", "capture", "captureFile", "image", "document", "contactCard", "set", "http", "knowledge", "extract", "delay", "subflow", "booking", "slots", "journey", "crm"] as FlowNode["type"][]).includes(node.type) && <div><label className="label">Then go to</label><TargetPicker nodeOptions={nodeOptions} value={(node as { next?: string }).next} onPick={(v) => onChange({ ...node, next: v } as FlowNode)} /></div>}
      {FALLIBLE.has(node.type) && (
        <div className="space-y-2 rounded-lg border border-amber-900/40 bg-amber-950/20 p-2">
          <p className="text-[11px] text-amber-300">This action can fail. Publishing is refused if a failure would continue into a node that tells the customer it worked.</p>
          <div><label className="label">If it fails, say (optional)</label><textarea className="input" rows={2} placeholder="I couldn't do that just yet — a person will pick it up." value={(node as { failureText?: string }).failureText ?? ""} onChange={(e) => onChange({ ...node, failureText: e.target.value || undefined } as FlowNode)} /></div>
          <div><label className="label">If it fails, go to</label><TargetPicker nodeOptions={nodeOptions} value={(node as { failureNext?: string }).failureNext} onPick={(v) => onChange({ ...node, failureNext: v } as FlowNode)} /></div>
          {node.type === "slots" && <div><label className="label">If nothing is available, go to</label><TargetPicker nodeOptions={nodeOptions} value={(node as { unavailableNext?: string }).unavailableNext} onPick={(v) => onChange({ ...node, unavailableNext: v } as FlowNode)} /><p className="mt-1 text-[10px] text-muted-foreground">Different from a failure: the request was fine, there is just no capacity right now.</p></div>}
        </div>
      )}
      {node.type === "ai" && <div><label className="label">On hand-off, go to</label><TargetPicker nodeOptions={nodeOptions} value={node.handoffNext} onPick={(v) => onChange({ ...node, handoffNext: v })} /></div>}

      {!isStart && <button onClick={onDelete} className="btn-danger btn-sm w-full">Delete node</button>}
    </div>
  );
}
