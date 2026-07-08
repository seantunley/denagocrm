"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { moveLead } from "@/app/actions/leads";
import { formatZAR } from "@/lib/format";
import TestDriveWeather from "@/components/TestDriveWeather";
import ResearchPopup from "@/components/ResearchPopup";

export type KanbanLead = {
  id: string;
  title: string;
  name: string;
  valueCents: number;
  quantity?: number;
  source: string;
  color: string | null;
  productName: string | null;
  assignee: string | null;
  testDrive?: { when: string; weather: string | null; date: string } | null;
  research?: string | null;
  isNew?: boolean;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export type KanbanStage = {
  id: string;
  name: string;
  color: string;
  leads: KanbanLead[];
};

const sourceIcons: Record<string, React.ReactNode> = {
  facebook: (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/branding/social-facebook.png" alt="Facebook" className="h-4 w-4 rounded-sm" />
  ),
  instagram: (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/branding/social-instagram.png" alt="Instagram" className="h-4 w-4 rounded-sm" />
  ),
  website: (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/branding/denago-mark.png" alt="Website" className="h-4 w-4 object-contain" />
  ),
  whatsapp: (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/branding/social-whatsapp.png" alt="WhatsApp" className="h-4 w-4 rounded-sm" />
  ),
  manual: "✍️",
};

function LeadCard({ lead, dragging }: { lead: KanbanLead; dragging?: boolean }) {
  return (
    <div
      className={`rounded-lg border border-slate-700 bg-slate-800 p-3 shadow-sm ${
        dragging ? "opacity-90 rotate-1 shadow-lg" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/leads/${lead.id}`}
          className="text-sm font-semibold text-slate-200 hover:text-orange-400 leading-snug"
        >
          {lead.isNew && (
            <span className="align-middle mr-1.5 rounded-full bg-emerald-500 text-white text-[9px] font-bold uppercase px-1.5 py-0.5 tracking-wide">
              New
            </span>
          )}
          {lead.title}
        </Link>
        <div className="flex items-center gap-0.5 shrink-0 mt-0.5">
          {lead.research && <ResearchPopup summary={lead.research} name={lead.name} />}
          <span title={lead.source}>{sourceIcons[lead.source] ?? "•"}</span>
        </div>
      </div>
      <p className="text-xs text-slate-400 mt-1">{lead.name}</p>
      {lead.productName && (
        <p className="text-xs text-slate-400">
          {lead.productName}
          {lead.color ? ` · ${lead.color}` : ""}
        </p>
      )}
      <div className="flex items-center justify-between mt-1.5">
        <div className="flex items-center gap-1.5">
          {lead.valueCents > 0 ? (
            <p className="text-xs font-semibold text-emerald-400">
              {formatZAR(lead.valueCents)}
            </p>
          ) : (
            <span />
          )}
          {(lead.quantity ?? 1) > 1 && (
            <span
              className="rounded bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40 text-[10px] font-bold px-1.5 py-0.5 leading-none"
              title={`${lead.quantity} units — bigger deal`}
            >
              ×{lead.quantity}
            </span>
          )}
        </div>
        {lead.assignee && (
          <span
            className="h-5 w-5 rounded-full bg-orange-600/80 text-white text-[9px] font-bold flex items-center justify-center"
            title={`Assigned to ${lead.assignee}`}
          >
            {initials(lead.assignee)}
          </span>
        )}
      </div>
      {lead.testDrive && (
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
          <span className="text-xs rounded-md bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 text-sky-300">
            🚗 {lead.testDrive.when}
          </span>
          {lead.testDrive.weather && (
            <TestDriveWeather
              date={lead.testDrive.date}
              when={lead.testDrive.when}
              summary={lead.testDrive.weather}
            />
          )}
        </div>
      )}
    </div>
  );
}

function DraggableCard({ lead }: { lead: KanbanLead }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: lead.id,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`touch-none ${isDragging ? "opacity-30" : ""}`}
    >
      <LeadCard lead={lead} />
    </div>
  );
}

function Column({ stage }: { stage: KanbanStage }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = stage.leads.reduce((s, l) => s + l.valueCents, 0);

  return (
    <div className="w-full md:w-auto md:flex-1 md:min-w-0 flex flex-col">
      <div className="flex items-center gap-2 px-1 mb-2">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: stage.color }}
        />
        <h3 className="text-sm font-semibold text-slate-300 truncate">{stage.name}</h3>
        <span className="text-xs text-slate-400">{stage.leads.length}</span>
        {total > 0 && (
          <span className="text-xs text-slate-400 ml-auto">{formatZAR(total)}</span>
        )}
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-32 space-y-2 rounded-xl p-2 transition-colors ${
          isOver ? "bg-orange-500/10 ring-2 ring-orange-500/40" : "bg-slate-900/50"
        }`}
      >
        {stage.leads.map((lead) => (
          <DraggableCard key={lead.id} lead={lead} />
        ))}
      </div>
    </div>
  );
}

export default function KanbanBoard({ stages: initial }: { stages: KanbanStage[] }) {
  const [stages, setStages] = useState(initial);
  const [activeLead, setActiveLead] = useState<KanbanLead | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => setStages(initial), [initial]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  function onDragStart(e: DragStartEvent) {
    const lead = stages.flatMap((s) => s.leads).find((l) => l.id === e.active.id);
    setActiveLead(lead ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveLead(null);
    const leadId = String(e.active.id);
    const targetStageId = e.over ? String(e.over.id) : null;
    if (!targetStageId) return;
    const fromStage = stages.find((s) => s.leads.some((l) => l.id === leadId));
    if (!fromStage || fromStage.id === targetStageId) return;

    setStages((prev) => {
      const lead = prev
        .flatMap((s) => s.leads)
        .find((l) => l.id === leadId)!;
      return prev.map((s) => {
        if (s.id === fromStage.id)
          return { ...s, leads: s.leads.filter((l) => l.id !== leadId) };
        if (s.id === targetStageId) return { ...s, leads: [...s.leads, lead] };
        return s;
      });
    });
    startTransition(() => {
      void moveLead(leadId, targetStageId);
    });
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="flex flex-col md:flex-row gap-4 pb-4 md:items-stretch select-none">
        {stages.map((stage) => (
          <Column key={stage.id} stage={stage} />
        ))}
      </div>
      <DragOverlay>{activeLead && <LeadCard lead={activeLead} dragging />}</DragOverlay>
    </DndContext>
  );
}
