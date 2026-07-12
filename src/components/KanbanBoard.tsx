"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { PenLine, Car, Hourglass, CircleAlert } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { moveLead, moveLeadToTestDrive } from "@/app/actions/leads";
import { formatZAR } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  productId?: string | null;
  productName: string | null;
  assignee: string | null;
  testDrive?: { when: string; weather: string | null; date: string } | null;
  research?: string | null;
  isNew?: boolean;
  noNextStep?: boolean;
  ageDays?: number;
};

const STALE_DAYS = 7; // in one stage this long → age flag

export type KanbanStage = {
  id: string;
  name: string;
  color: string;
  leads: KanbanLead[];
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

function SourceIcon({ source }: { source: string }) {
  const social: Record<string, string> = {
    facebook: "/branding/social-facebook.png",
    instagram: "/branding/social-instagram.png",
    whatsapp: "/branding/social-whatsapp.png",
    website: "/branding/denago-mark.png",
  };
  if (social[source]) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={social[source]} alt={source} className="size-4 rounded-sm object-contain" />;
  }
  return <PenLine className="size-3.5 text-muted-foreground" />;
}

function LeadCard({ lead, dragging }: { lead: KanbanLead; dragging?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-3 shadow-sm transition-all",
        dragging
          ? "rotate-2 cursor-grabbing shadow-xl ring-1 ring-primary/40"
          : "cursor-grab hover:border-primary/30 hover:shadow-md hover:shadow-black/20"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/leads/${lead.id}`}
          className="text-[13px] font-medium leading-snug text-foreground hover:text-primary"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {lead.isNew && (
            <span className="mr-1.5 inline-flex items-center rounded bg-emerald-500/15 px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wide text-emerald-400 ring-1 ring-emerald-500/25">
              New
            </span>
          )}
          {lead.title}
        </Link>
        <div className="mt-0.5 flex shrink-0 items-center gap-1">
          {(lead.ageDays ?? 0) >= STALE_DAYS && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-bold text-amber-300">
                  <Hourglass className="size-2.5" />
                  {lead.ageDays}d
                </span>
              </TooltipTrigger>
              <TooltipContent>In this stage for {lead.ageDays} days — move it or close it</TooltipContent>
            </Tooltip>
          )}
          {lead.noNextStep && (lead.ageDays ?? 0) >= 1 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center rounded bg-red-500/15 p-0.5 text-red-300">
                  <CircleAlert className="size-3" />
                </span>
              </TooltipTrigger>
              <TooltipContent>No next step planned — open the lead and schedule one</TooltipContent>
            </Tooltip>
          )}
          {lead.research && <ResearchPopup summary={lead.research} name={lead.name} />}
          <span title={lead.source}>
            <SourceIcon source={lead.source} />
          </span>
        </div>
      </div>

      <p className="mt-1 truncate text-xs text-muted-foreground">{lead.name}</p>
      {lead.productName && (
        <p className="truncate text-xs text-muted-foreground/80">
          {lead.productName}
          {lead.color ? ` · ${lead.color}` : ""}
        </p>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {lead.valueCents > 0 ? (
            <span className="text-[13px] font-semibold tabular-nums text-emerald-400">
              {formatZAR(lead.valueCents)}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/50">—</span>
          )}
          {(lead.quantity ?? 1) > 1 && (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold leading-none text-amber-300 ring-1 ring-amber-500/30"
              title={`${lead.quantity} units — bigger deal`}
            >
              ×{lead.quantity}
            </span>
          )}
        </div>
        {lead.assignee && (
          <Avatar className="size-5" title={`Assigned to ${lead.assignee}`}>
            <AvatarFallback className="bg-primary/15 text-[8px] font-bold text-primary">
              {initials(lead.assignee)}
            </AvatarFallback>
          </Avatar>
        )}
      </div>

      {lead.testDrive && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-300 ring-1 ring-sky-500/20">
            <Car className="size-3" />
            {lead.testDrive.when}
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
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: lead.id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn("touch-none", isDragging && "opacity-30")}
    >
      <LeadCard lead={lead} />
    </div>
  );
}

function Column({ stage }: { stage: KanbanStage }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = stage.leads.reduce((s, l) => s + l.valueCents, 0);

  return (
    <div className="flex w-full flex-col md:w-[300px] md:shrink-0">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="size-2 rounded-full" style={{ backgroundColor: stage.color }} />
        <h3 className="truncate text-[13px] font-semibold text-foreground">{stage.name}</h3>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {stage.leads.length}
        </span>
        {total > 0 && (
          <span className="ml-auto text-[11px] font-medium tabular-nums text-muted-foreground">
            {formatZAR(total)}
          </span>
        )}
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "min-h-32 flex-1 space-y-2 rounded-xl p-2 transition-colors",
          isOver ? "bg-primary/5 ring-1 ring-inset ring-primary/30" : "bg-muted/30"
        )}
      >
        {stage.leads.map((lead) => (
          <DraggableCard key={lead.id} lead={lead} />
        ))}
        {stage.leads.length === 0 && !isOver && (
          <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-border/60 text-[11px] text-muted-foreground/50">
            No leads
          </div>
        )}
      </div>
    </div>
  );
}

export default function KanbanBoard({
  stages: initial,
  products = [],
}: {
  stages: KanbanStage[];
  products?: { id: string; name: string }[];
}) {
  const [stages, setStages] = useState(initial);
  const [activeLead, setActiveLead] = useState<KanbanLead | null>(null);
  const [pendingTd, setPendingTd] = useState<{ lead: KanbanLead; stageId: string } | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => setStages(initial), [initial]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  function onDragStart(e: DragStartEvent) {
    const lead = stages.flatMap((s) => s.leads).find((l) => l.id === e.active.id);
    setActiveLead(lead ?? null);
  }

  function applyMove(leadId: string, fromStageId: string, targetStageId: string) {
    setStages((prev) => {
      const lead = prev.flatMap((s) => s.leads).find((l) => l.id === leadId)!;
      return prev.map((s) => {
        if (s.id === fromStageId) return { ...s, leads: s.leads.filter((l) => l.id !== leadId) };
        if (s.id === targetStageId) return { ...s, leads: [...s.leads, lead] };
        return s;
      });
    });
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveLead(null);
    const leadId = String(e.active.id);
    const targetStageId = e.over ? String(e.over.id) : null;
    if (!targetStageId) return;
    const fromStage = stages.find((s) => s.leads.some((l) => l.id === leadId));
    if (!fromStage || fromStage.id === targetStageId) return;

    // Dropping into the test-drive stage captures the booking first —
    // the move only commits once the details are saved.
    const target = stages.find((s) => s.id === targetStageId);
    if (target && /test/i.test(target.name)) {
      const lead = stages.flatMap((s) => s.leads).find((l) => l.id === leadId)!;
      setPendingTd({ lead, stageId: targetStageId });
      return;
    }

    applyMove(leadId, fromStage.id, targetStageId);
    startTransition(() => {
      void moveLead(leadId, targetStageId);
    });
  }

  function confirmTestDrive(data: { productId: string | null; date: string; time: string; location: string }) {
    if (!pendingTd) return;
    const { lead, stageId } = pendingTd;
    const fromStage = stages.find((s) => s.leads.some((l) => l.id === lead.id));
    setPendingTd(null);
    if (!fromStage) return;
    applyMove(lead.id, fromStage.id, stageId);
    startTransition(async () => {
      const res = await moveLeadToTestDrive(lead.id, stageId, data).catch(() => ({
        ok: false as const,
        error: "Something went wrong",
      }));
      if (res.ok) {
        toast.success(`Test drive booked for ${lead.name}`, {
          description: `${data.date} at ${data.time}${data.location ? ` · ${data.location}` : ""}`,
        });
      } else {
        toast.error(res.error ?? "Couldn't book the test drive");
      }
    });
  }

  // Drop where the pointer is; fall back to overlap for keyboard/edge cases.
  const collisionDetection: CollisionDetection = (args) => {
    const byPointer = pointerWithin(args);
    return byPointer.length > 0 ? byPointer : rectIntersection(args);
  };

  return (
    <DndContext
      id="leads-board"
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="flex select-none flex-col gap-4 pb-4 md:flex-row md:items-stretch md:overflow-x-auto">
        {stages.map((stage) => (
          <Column key={stage.id} stage={stage} />
        ))}
      </div>
      <DragOverlay>{activeLead && <LeadCard lead={activeLead} dragging />}</DragOverlay>

      <TestDriveDialog
        pending={pendingTd}
        products={products}
        onCancel={() => setPendingTd(null)}
        onConfirm={confirmTestDrive}
      />
    </DndContext>
  );
}

/** Capture the booking when a lead lands in the test-drive stage. */
function TestDriveDialog({
  pending,
  products,
  onCancel,
  onConfirm,
}: {
  pending: { lead: KanbanLead; stageId: string } | null;
  products: { id: string; name: string }[];
  onCancel: () => void;
  onConfirm: (data: { productId: string | null; date: string; time: string; location: string }) => void;
}) {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const [productId, setProductId] = useState<string>("");
  const [date, setDate] = useState(tomorrow);
  const [time, setTime] = useState("10:00");
  const [location, setLocation] = useState("Denago Cape Town showroom");

  // Re-seed the form each time a new lead is dropped in
  useEffect(() => {
    if (pending) {
      setProductId(pending.lead.productId ?? "");
      setDate(tomorrow);
      setTime("10:00");
      setLocation("Denago Cape Town showroom");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.lead.id]);

  const input =
    "w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";

  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        {pending && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Car className="size-4 text-primary" />
                Book the test drive
              </DialogTitle>
              <DialogDescription>
                <span className="font-medium text-foreground">{pending.lead.name}</span>
                {" is moving to test drive — capture the details so the appointment isn't lost."}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Model to drive
                </label>
                <select className={input} value={productId} onChange={(e) => setProductId(e.target.value)}>
                  <option value="">— keep current{pending.lead.productName ? ` (${pending.lead.productName})` : ""} —</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Date</label>
                  <input type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Time</label>
                  <input type="time" className={input} value={time} onChange={(e) => setTime(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Location</label>
                <input
                  className={input}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Showroom, estate, customer's address…"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel — don&apos;t move
              </Button>
              <Button
                size="sm"
                onClick={() => onConfirm({ productId: productId || null, date, time, location })}
              >
                <Car className="size-4" />
                Book &amp; move
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
