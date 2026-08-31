"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import {
  Bot,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Database,
  FileQuestion,
  GitBranch,
  Hand,
  ImageIcon,
  MessageSquare,
  Sparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";

const groups: Array<{
  label: string;
  description: string;
  nodes: Array<{ label: string; detail: string; icon: LucideIcon }>;
}> = [
  {
    label: "Messages",
    description: "What the customer sees or receives.",
    nodes: [
      { label: "Message", detail: "Send plain conversation content.", icon: MessageSquare },
      { label: "Menu", detail: "Offer named choices with one route per option.", icon: GitBranch },
      { label: "Send image", detail: "Send existing media to the customer.", icon: ImageIcon },
      { label: "Answer", detail: "Return an existing structured answer source.", icon: Sparkles },
    ],
  },
  {
    label: "Customer input",
    description: "Collect information without hiding where it is stored.",
    nodes: [
      { label: "Ask & save", detail: "Capture a response into a flow variable.", icon: FileQuestion },
      { label: "Get a file", detail: "Capture an uploaded file into a variable.", icon: FileQuestion },
    ],
  },
  {
    label: "Logic & data",
    description: "Make branching and state changes readable on the canvas.",
    nodes: [
      { label: "Condition", detail: "Route Yes/No using an existing condition.", icon: GitBranch },
      { label: "Workshop slots", detail: "Offer available workshop slots and explicit fallbacks.", icon: CalendarDays },
      { label: "CRM / booking action", detail: "Run the existing CRM booking action and expose outcomes.", icon: Wrench },
      { label: "Start Journey", detail: "Enrol the customer in an existing Journey.", icon: Workflow },
    ],
  },
  {
    label: "AI & operations",
    description: "Make automated and human ownership boundaries obvious.",
    nodes: [
      { label: "AI answer", detail: "Use the existing grounded AI answer behaviour.", icon: Bot },
      { label: "Hand off", detail: "Transfer the conversation to staff.", icon: Hand },
      { label: "End", detail: "Terminate the current flow explicitly.", icon: CircleStop },
    ],
  },
];

// These colours describe only the outcome-coloured handles that exist today on
// condition and fallible action nodes. Other handles remain type-coloured.
const routeLegend = [
  { label: "Success / Yes", className: "bg-emerald-400" },
  { label: "No", className: "bg-red-400" },
  { label: "If it fails", className: "bg-amber-400" },
  { label: "Unavailable", className: "bg-slate-400" },
];

export default function FlowNodeSystemFrame({ children }: { children: ReactNode }) {
  const [guideOpen, setGuideOpen] = useState(false);

  return (
    <section className="space-y-3" aria-label="Flow node workspace">
      <div className="rounded-xl border border-border bg-card/65 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Node system</p>
            <p className="mt-0.5 text-sm font-medium">Read the flow from the canvas before opening the inspector.</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground" aria-label="Outcome route legend">
            {routeLegend.map((item) => (
              <span key={item.label} className="inline-flex items-center gap-1.5">
                <span className={`size-2 rounded-full ${item.className}`} aria-hidden />
                {item.label}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="btn-secondary btn-sm min-h-11"
            onClick={() => setGuideOpen((value) => !value)}
            aria-expanded={guideOpen}
            aria-controls="flow-node-guide"
          >
            <Database className="size-4" aria-hidden="true" />
            Node guide
            {guideOpen ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
          </button>
        </div>

        {guideOpen ? (
          <div id="flow-node-guide" className="mt-3 grid gap-3 border-t border-border/70 pt-3 md:grid-cols-2 xl:grid-cols-4">
            {groups.map((group) => (
              <section key={group.label} className="rounded-xl border border-border/70 bg-muted/20 p-3">
                <h3 className="text-xs font-semibold">{group.label}</h3>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{group.description}</p>
                <ul className="mt-3 space-y-2">
                  {group.nodes.map((node) => {
                    const Icon = node.icon;
                    return (
                      <li key={node.label} className="flex gap-2.5">
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-card"><Icon className="size-3.5" aria-hidden="true" /></span>
                        <div className="min-w-0"><p className="text-xs font-medium">{node.label}</p><p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{node.detail}</p></div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : null}
      </div>

      <div className={[
        "[&_.react-flow__node-flowNode]:transition-[filter,transform] [&_.react-flow__node-flowNode]:duration-150",
        "[&_.react-flow__node-flowNode:hover]:z-10 [&_.react-flow__node-flowNode:hover]:drop-shadow-xl",
        "[&_.react-flow__node-flowNode.selected]:z-20",
        "[&_.react-flow__node-flowNode.selected>div]:ring-[3px] [&_.react-flow__node-flowNode.selected>div]:ring-primary/35",
        "[&_.react-flow__handle]:!size-3.5 [&_.react-flow__handle]:!border-2 [&_.react-flow__handle]:!border-slate-950",
        "[&_.react-flow__node-flowNode_.react-flow__handle]:transition-transform",
        "[&_.react-flow__node-flowNode:hover_.react-flow__handle]:scale-110",
        "[&_.react-flow__edge-path]:transition-[stroke,stroke-width,opacity]",
        "[&_.react-flow__edge.selected_.react-flow__edge-path]:!stroke-primary [&_.react-flow__edge.selected_.react-flow__edge-path]:!stroke-[3px]",
        "[&_.react-flow__node-flowNode>div>div]:leading-5",
      ].join(" ")}>{children}</div>
    </section>
  );
}