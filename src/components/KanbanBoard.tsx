"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  ArrowUpRight,
  CalendarClock,
  Car,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FilterX,
  GripVertical,
  Hourglass,
  PenLine,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import LocationAutocomplete from "@/components/LocationAutocomplete";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { moveLead, moveLeadToTestDrive } from "@/app/actions/leads";
import { formatZAR } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  ResponsiveDialogContent,
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
  signing?: { label: string } | null;
  research?: string | null;
  isNew?: boolean;
  noNextStep?: boolean;
  ageDays?: number;
  nextStep?: { summary: string; when: string; overdue: boolean } | null;
};

const STALE_DAYS = 7;

// Centre the dragged card on the cursor. Cards are grabbed by their top-left handle,
// which otherwise floats the card up-and-right of the pointer, so what you see and
// where it drops disagree. This makes the card sit under the pointer, matching the
// pointer-based drop target. Handles mouse + touch without an extra dependency.
const snapCenterToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!draggingNodeRect || !activatorEvent) return transform;
  const e = activatorEvent as MouseEvent & TouchEvent;
  const x = e.touches?.[0]?.clientX ?? e.clientX;
  const y = e.touches?.[0]?.clientY ?? e.clientY;
  if (x == null || y == null) return transform;
  return {
    ...transform,
    x: transform.x + x - draggingNodeRect.left - draggingNodeRect.width / 2,
    y: transform.y + y - draggingNodeRect.top - draggingNodeRect.height / 2,
  };
};

export type KanbanStage = {
  id: string;
  name: string;
  color: string;
  leads: KanbanLead[];
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((word) => word[0])
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
  const opportunity = lead.title !== lead.name && lead.title !== lead.productName ? lead.title : null;

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border bg-card p-3.5 shadow-sm transition-all",
        dragging
          ? "rotate-1 cursor-grabbing shadow-2xl ring-1 ring-primary/50"
          : "cursor-grab hover:-translate-y-px hover:border-primary/35 hover:shadow-lg hover:shadow-black/20",
        lead.isNew && !dragging && "animate-new-lead-glow",
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />

      <div className="flex items-start gap-2.5">
        <GripVertical
          className="mt-0.5 size-4 shrink-0 text-muted-foreground/35 transition-colors group-hover:text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <Link
            href={`/leads/${lead.id}`}
            className="block truncate text-sm font-semibold leading-snug text-foreground transition-colors hover:text-primary"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {lead.name}
          </Link>
          {(lead.productName || opportunity) && (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
              {lead.productName && (
                <span className="max-w-full truncate rounded-md border border-white/[0.06] bg-white/[0.035] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {lead.productName}
                  {lead.color ? ` · ${lead.color}` : ""}
                </span>
              )}
              {opportunity && <span className="truncate text-[11px] text-muted-foreground">{opportunity}</span>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {lead.isNew && (
            <span className="inline-flex items-center rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-400 ring-1 ring-emerald-500/25">
              New
            </span>
          )}
          {lead.research && <ResearchPopup summary={lead.research} name={lead.name} />}
          <span title={`Source: ${lead.source}`}>
            <SourceIcon source={lead.source} />
          </span>
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3 border-t border-border/70 pt-3">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-muted-foreground/70">Deal value</p>
          <div className="mt-1 flex items-center gap-1.5">
            {lead.valueCents > 0 ? (
              <span className="text-sm font-semibold tabular-nums text-foreground">{formatZAR(lead.valueCents)}</span>
            ) : (
              <span className="text-xs text-muted-foreground/50">Not estimated</span>
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
        </div>
        {lead.assignee && (
          <div className="flex shrink-0 items-center gap-1.5" title={`Assigned to ${lead.assignee}`}>
            <span className="hidden max-w-20 truncate text-[10px] text-muted-foreground xl:block">{lead.assignee}</span>
            <Avatar className="size-6">
              <AvatarFallback className="bg-primary/15 text-[8px] font-bold text-primary">
                {initials(lead.assignee)}
              </AvatarFallback>
            </Avatar>
          </div>
        )}
      </div>

      <div className="mt-3 rounded-lg border border-border/70 bg-background/30 px-2.5 py-2">
        {lead.nextStep ? (
          <div className="flex items-start gap-2">
            <CalendarClock
              className={cn("mt-0.5 size-3.5 shrink-0", lead.nextStep.overdue ? "text-red-300" : "text-primary")}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-medium text-foreground">{lead.nextStep.summary}</p>
              <p
                className={cn(
                  "mt-0.5 text-[10px]",
                  lead.nextStep.overdue ? "font-medium text-red-300" : "text-muted-foreground",
                )}
              >
                {lead.nextStep.when}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[10px] text-amber-300">
            <CircleAlert className="size-3.5" />
            No next step scheduled
          </div>
        )}
      </div>

      {lead.signing && (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-amber-500/15 bg-amber-500/[0.07] px-2.5 py-2 text-[10px] font-medium text-amber-300">
          <PenLine className="size-3.5 shrink-0" />
          <span className="truncate">{lead.signing.label}</span>
        </div>
      )}

      <div className="mt-2.5 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {(lead.ageDays ?? 0) >= STALE_DAYS && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                  <Hourglass className="size-3" />
                  {lead.ageDays} days in stage
                </span>
              </TooltipTrigger>
              <TooltipContent>Move this opportunity forward or close it</TooltipContent>
            </Tooltip>
          )}
          {lead.testDrive && (
            <>
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
            </>
          )}
        </div>
        <Link
          href={`/leads/${lead.id}`}
          onPointerDown={(event) => event.stopPropagation()}
          className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary hover:text-primary/80"
        >
          Open <ArrowUpRight className="size-3" />
        </Link>
      </div>
    </div>
  );
}

function DraggableCard({ lead }: { lead: KanbanLead }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: lead.id });
  // No touch-action:none on the card: the TouchSensor's press-delay decides drag
  // vs scroll, so leaving native touch scrolling on lets the board/columns scroll.
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn("select-none", isDragging && "opacity-30")}
    >
      <LeadCard lead={lead} />
    </div>
  );
}

function Column({ stage }: { stage: KanbanStage }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = stage.leads.reduce((sum, lead) => sum + lead.valueCents, 0);

  // Droppable is the WHOLE column (header + body), so the pointer-X drop detection
  // has the full column width/height to work with.
  return (
    <section
      ref={setNodeRef}
      id={`pipeline-stage-${stage.id}`}
      className="flex w-[min(88vw,22rem)] shrink-0 snap-start flex-col overflow-hidden rounded-2xl border border-border bg-card/35 shadow-sm md:w-[320px]"
      aria-labelledby={`pipeline-stage-title-${stage.id}`}
    >
      <header className="relative border-b border-border bg-card/95 px-4 py-3.5 backdrop-blur">
        <span className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: stage.color }} />
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full shadow-[0_0_12px_currentColor]"
              style={{ backgroundColor: stage.color, color: stage.color }}
            />
            <h3 id={`pipeline-stage-title-${stage.id}`} className="truncate text-sm font-semibold text-foreground">
              {stage.name}
            </h3>
            <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
              {stage.leads.length}
            </span>
          </div>
          <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">
            {total > 0 ? formatZAR(total) : "—"}
          </span>
        </div>
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          {stage.leads.length === 1 ? "1 active opportunity" : `${stage.leads.length} active opportunities`}
        </p>
      </header>
      <div
        className={cn(
          "min-h-[26rem] flex-1 space-y-2.5 p-2.5 transition-colors",
          isOver ? "bg-primary/[0.07] ring-1 ring-inset ring-primary/35" : "bg-background/20",
        )}
      >
        {stage.leads.map((lead) => (
          <DraggableCard key={lead.id} lead={lead} />
        ))}
        {stage.leads.length === 0 && !isOver && (
          <div className="flex min-h-32 flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-card/25 px-5 text-center">
            <span className="grid size-8 place-items-center rounded-full border border-border bg-muted/40 text-muted-foreground">
              <GripVertical className="size-3.5" />
            </span>
            <p className="mt-3 text-xs font-medium text-muted-foreground">Drop a lead into {stage.name}</p>
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground/65">
              Stage rules and automations run after the move.
            </p>
          </div>
        )}
      </div>
    </section>
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
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const [, startTransition] = useTransition();

  useEffect(() => setStages(initial), [initial]);

  const sensors = useSensors(
    // Mouse: start dragging after an 8px move — precise, no delay.
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    // Touch: require a short press-and-hold before dragging. A quick swipe (which
    // moves past the tolerance before the delay elapses) is treated as a scroll,
    // so the board/columns scroll normally instead of grabbing a card by accident.
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const owners = useMemo(
    () =>
      Array.from(
        new Set(stages.flatMap((stage) => stage.leads.map((lead) => lead.assignee).filter(Boolean) as string[])),
      ).sort(),
    [stages],
  );

  const visibleStages = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return stages.map((stage) => ({
      ...stage,
      leads: stage.leads.filter((lead) => {
        const matchesQuery =
          !needle ||
          [lead.name, lead.title, lead.productName, lead.color, lead.source, lead.nextStep?.summary]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(needle);
        const matchesOwner = !owner || lead.assignee === owner;
        const needsAttention =
          !attentionOnly || lead.noNextStep || lead.nextStep?.overdue || (lead.ageDays ?? 0) >= STALE_DAYS;
        return matchesQuery && matchesOwner && needsAttention;
      }),
    }));
  }, [attentionOnly, owner, query, stages]);

  const visibleCount = visibleStages.reduce((count, stage) => count + stage.leads.length, 0);
  const totalCount = stages.reduce((count, stage) => count + stage.leads.length, 0);

  function scrollBoard(direction: -1 | 1) {
    boardRef.current?.scrollBy({ left: direction * 340, behavior: "smooth" });
  }

  function scrollToStage(stageId: string) {
    const stage = document.getElementById(`pipeline-stage-${stageId}`);
    stage?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
  }

  function onDragStart(event: DragStartEvent) {
    const lead = stages.flatMap((stage) => stage.leads).find((item) => item.id === event.active.id);
    setActiveLead(lead ?? null);
  }

  function applyMove(leadId: string, fromStageId: string, targetStageId: string) {
    setStages((previous) => {
      const lead = previous.flatMap((stage) => stage.leads).find((item) => item.id === leadId)!;
      return previous.map((stage) => {
        if (stage.id === fromStageId) {
          return { ...stage, leads: stage.leads.filter((item) => item.id !== leadId) };
        }
        if (stage.id === targetStageId) return { ...stage, leads: [...stage.leads, lead] };
        return stage;
      });
    });
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveLead(null);
    const leadId = String(event.active.id);
    const targetStageId = event.over ? String(event.over.id) : null;
    if (!targetStageId) return;
    const fromStage = stages.find((stage) => stage.leads.some((lead) => lead.id === leadId));
    if (!fromStage || fromStage.id === targetStageId) return;

    const target = stages.find((stage) => stage.id === targetStageId);
    if (target && /test/i.test(target.name)) {
      const lead = stages.flatMap((stage) => stage.leads).find((item) => item.id === leadId)!;
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
    const fromStage = stages.find((stage) => stage.leads.some((item) => item.id === lead.id));
    setPendingTd(null);
    if (!fromStage) return;
    applyMove(lead.id, fromStage.id, stageId);
    startTransition(async () => {
      const result = await moveLeadToTestDrive(lead.id, stageId, data).catch(() => ({
        ok: false as const,
        error: "Something went wrong",
      }));
      if (result.ok) {
        toast.success(`Test drive booked for ${lead.name}`, {
          description: `${data.date} at ${data.time}${data.location ? ` · ${data.location}` : ""}`,
        });
      } else {
        toast.error(result.error ?? "Couldn't book the test drive");
      }
    });
  }

  // The board is a horizontal, scrollable strip of columns, so the drop target is
  // ALWAYS "the column whose horizontal span the pointer is over". We compare the
  // pointer's client X against each column's LIVE getBoundingClientRect() — the same
  // (viewport/client) coordinate space as the pointer. dnd-kit's own droppableRects
  // are scroll-adjusted into a different space, which is what caused the drop target
  // to land one column off from the cursor.
  const collisionDetection: CollisionDetection = (args) => {
    const x = args.pointerCoordinates?.x;
    if (x == null) return pointerWithin(args); // keyboard / no pointer
    type Id = (typeof args.droppableContainers)[number]["id"];
    let inside: Id | null = null;
    let nearest: { id: Id; dist: number } | null = null;
    for (const container of args.droppableContainers) {
      const el = container.node.current;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right) {
        inside = container.id;
        break;
      }
      const dist = Math.abs(x - (rect.left + rect.width / 2));
      if (!nearest || dist < nearest.dist) nearest = { id: container.id, dist };
    }
    if (inside) return [{ id: inside }];
    return nearest ? [{ id: nearest.id }] : [];
  };

  return (
    <>
      <div className="rounded-2xl border border-border bg-card/70 p-3 shadow-sm backdrop-blur sm:p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row">
            <label className="relative min-w-0 flex-1 xl:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="input h-10 pl-9"
                placeholder="Search customer, product, source…"
                aria-label="Search pipeline leads"
              />
            </label>
            <select
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              className="input h-10 sm:w-44"
              aria-label="Filter by owner"
            >
              <option value="">All owners</option>
              {owners.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setAttentionOnly((value) => !value)}
              className={cn(
                "btn-secondary h-10",
                attentionOnly && "border-amber-400/35 bg-amber-500/10 text-amber-200",
              )}
              aria-pressed={attentionOnly}
            >
              <CircleAlert className="size-4" />
              Needs attention
            </button>
            {(query || owner || attentionOnly) && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setOwner("");
                  setAttentionOnly(false);
                }}
                className="btn h-10 text-muted-foreground"
              >
                <FilterX className="size-4" />
                Clear
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              <span className="font-semibold tabular-nums text-foreground">{visibleCount}</span>
              {visibleCount !== totalCount ? ` of ${totalCount}` : ""} opportunities
            </p>
            <div className="hidden items-center gap-1 md:flex">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={() => scrollBoard(-1)}
                aria-label="Previous pipeline stages"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={() => scrollBoard(1)}
                aria-label="Next pipeline stages"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>

        <nav
          className="mt-3 flex gap-1.5 overflow-x-auto border-t border-border pt-3 md:hidden"
          aria-label="Pipeline stages"
        >
          {visibleStages.map((stage) => (
            <button
              key={stage.id}
              type="button"
              onClick={() => scrollToStage(stage.id)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/35 px-3 py-1.5 text-xs font-medium text-muted-foreground"
            >
              <span className="size-1.5 rounded-full" style={{ backgroundColor: stage.color }} />
              {stage.name}
              <span className="tabular-nums">{stage.leads.length}</span>
            </button>
          ))}
        </nav>
      </div>

      <DndContext
        id="leads-board"
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={[snapCenterToCursor]}
        // Re-measure column rects continuously so horizontal scrolling can't leave
        // the drop detection reading stale positions.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveLead(null)}
      >
        <div
          ref={boardRef}
          className="flex snap-x snap-mandatory select-none gap-4 overflow-x-auto pb-3 pt-1 [scrollbar-gutter:stable]"
        >
          {visibleStages.map((stage) => (
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
    </>
  );
}

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
  const [productId, setProductId] = useState("");
  const [date, setDate] = useState(tomorrow);
  const [time, setTime] = useState("10:00");
  const [location, setLocation] = useState("Denago Cape Town showroom");

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
    <Dialog open={!!pending} onOpenChange={(open) => !open && onCancel()}>
      <ResponsiveDialogContent className="sm:max-w-md">
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
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Model to drive</label>
                <select className={input} value={productId} onChange={(event) => setProductId(event.target.value)}>
                  <option value="">
                    — keep current{pending.lead.productName ? ` (${pending.lead.productName})` : ""} —
                  </option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Date</label>
                  <input type="date" className={input} value={date} onChange={(event) => setDate(event.target.value)} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Time</label>
                  <input type="time" className={input} value={time} onChange={(event) => setTime(event.target.value)} />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Location</label>
                <LocationAutocomplete
                  className={input}
                  value={location}
                  onValueChange={setLocation}
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
      </ResponsiveDialogContent>
    </Dialog>
  );
}
