"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  CalendarPlus,
  Car,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ListChecks,
  FilterX,
  GripVertical,
  Hourglass,
  Link as LinkIcon,
  MoreHorizontal,
  PenLine,
  Search,
  Trophy,
  UserPlus,
  UserRound,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import LocationAutocomplete from "@/components/LocationAutocomplete";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  assignLead,
  convertLeadToContact,
  markLost,
  markWon,
  moveLead,
  moveLeadToTestDrive,
  moveLeadWithContact,
  searchLinkableContacts,
} from "@/app/actions/leads";
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
import NotesPopup, { type PinnedNote } from "@/components/NotesPopup";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isStale, matchesOwnerFilter, OWNER_ANY, OWNER_UNASSIGNED } from "@/lib/kanbanRules";
// The registry decides WHICH dialog a remedy opens, so adding one does not add a
// branch to this file.
import { STAGE_REMEDIES, remedyFor } from "@/lib/stageRemedies";
// Pure module — one import, from a file with none — so the board and the server
// describe an unmet criterion with the SAME sentence. A second copy of this
// wording here is how the refusal and the warning start disagreeing.
import { MIN_OVERRIDE_REASON, describeUnmet, type StageGateVerdict } from "@/lib/stageGate";

export type KanbanLead = {
  id: string;
  title: string;
  name: string;
  contactId?: string | null;
  valueCents: number;
  quantity?: number;
  source: string;
  color: string | null;
  productId?: string | null;
  productName: string | null;
  assignedToId: string | null;
  assignee: string | null;
  testDrive?: { when: string; weather: string | null; date: string } | null;
  signing?: { label: string } | null;
  research?: string | null;
  /** Note text from the lead and/or its linked contact, for the card's note icon. */
  /** Notes that are PINNED on this lead or its contact. Empty/absent = no icon. */
  notes?: PinnedNote[] | null;
  isNew?: boolean;
  noNextStep?: boolean;
  ageDays?: number;
  nextStep?: { summary: string; when: string; overdue: boolean } | null;
};



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
  entryAction: string | null;
  /** From the stage's own configuration; null falls back to DEFAULT_STALE_DAYS. */
  staleAfterDays: number | null;
  automationRules: string[];
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

function LeadCard({ lead, dragging, actions, staleAfterDays = null }: { lead: KanbanLead; dragging?: boolean; actions?: ReactNode; staleAfterDays?: number | null }) {
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
          {lead.notes?.length ? <NotesPopup notes={lead.notes} name={lead.name} /> : null}
          {lead.research && <ResearchPopup summary={lead.research} name={lead.name} />}
          <span title={`Source: ${lead.source}`}>
            <SourceIcon source={lead.source} />
          </span>
          {actions}
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
          {isStale(lead.ageDays, staleAfterDays) && (
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

type LeadActionHandlers = {
  open: () => void;
  schedule: () => void;
  move: (stageId: string) => void;
  assign: (userId: string) => void;
  testDrive: () => void;
  won: () => void;
  lost: () => void;
  copyLink: () => void;
  addToContacts: () => void;
};

type BoardPermissions = {
  canChangeStage: boolean;
  canAssign: boolean;
  canManageActivities: boolean;
  canMarkWon: boolean;
  canMarkLost: boolean;
};

function LeadMenuItems({
  kind,
  lead,
  stages,
  users,
  permissions,
  actions,
}: {
  kind: "context" | "dropdown";
  lead: KanbanLead;
  stages: KanbanStage[];
  users: { id: string; name: string }[];
  permissions: BoardPermissions;
  actions: LeadActionHandlers;
}) {
  const Item = kind === "context" ? ContextMenuItem : DropdownMenuItem;
  const Label = kind === "context" ? ContextMenuLabel : DropdownMenuLabel;
  const Separator = kind === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
  const Sub = kind === "context" ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger = kind === "context" ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent = kind === "context" ? ContextMenuSubContent : DropdownMenuSubContent;
  const currentStage = stages.find((stage) => stage.leads.some((item) => item.id === lead.id));
  // The "Book a test drive" shortcut jumps to whichever stage asks for one. This
  // one IS test-drive-specific — it is a menu item about test drives, not a
  // decision about which dialog a rule needs — so it names the action directly.
  const testDriveStage = stages.find((stage) => stage.entryAction === "book_test_drive");

  return (
    <>
      <Label>{lead.name}</Label>
      <Item onSelect={actions.open}>
        <ArrowUpRight /> Open lead
      </Item>
      <Item disabled={!permissions.canManageActivities} onSelect={actions.schedule}>
        <CalendarPlus /> Schedule activity
      </Item>
      {!lead.contactId && (
        <Item onSelect={actions.addToContacts}>
          <UserPlus /> Add to contacts
        </Item>
      )}
      <Separator />
      <Sub>
        <SubTrigger disabled={!permissions.canChangeStage}>
          <GripVertical /> Move to stage
        </SubTrigger>
        <SubContent>
          {stages.map((stage) => (
            <Item
              key={stage.id}
              disabled={stage.id === currentStage?.id}
              onSelect={() => actions.move(stage.id)}
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: stage.color }} />
              {stage.name}
            </Item>
          ))}
        </SubContent>
      </Sub>
      <Sub>
        <SubTrigger disabled={!permissions.canAssign}>
          <UserRound /> Assign owner
        </SubTrigger>
        <SubContent>
          {users.map((user) => (
            <Item
              key={user.id}
              disabled={user.id === lead.assignedToId}
              onSelect={() => actions.assign(user.id)}
            >
              <Avatar className="size-5">
                <AvatarFallback className="text-[7px]">{initials(user.name)}</AvatarFallback>
              </Avatar>
              {user.name}
            </Item>
          ))}
        </SubContent>
      </Sub>
      <Item disabled={!permissions.canChangeStage || !testDriveStage} onSelect={actions.testDrive}>
        <Car /> {lead.testDrive ? "Reschedule test drive" : "Book test drive"}
      </Item>
      <Separator />
      <Item disabled={!permissions.canMarkWon} onSelect={actions.won}>
        <Trophy /> Mark won
      </Item>
      <Item disabled={!permissions.canMarkLost} variant="destructive" onSelect={actions.lost}>
        <XCircle /> Mark lost
      </Item>
      <Separator />
      <Item onSelect={actions.copyLink}>
        <LinkIcon /> Copy lead link
      </Item>
    </>
  );
}

function LeadActionsButton({
  lead,
  stages,
  users,
  permissions,
  actions,
}: {
  lead: KanbanLead;
  stages: KanbanStage[];
  users: { id: string; name: string }[];
  permissions: BoardPermissions;
  actions: LeadActionHandlers;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-70 hover:bg-muted hover:text-foreground group-hover:opacity-100"
          aria-label={`Actions for ${lead.name}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <LeadMenuItems
          kind="dropdown"
          lead={lead}
          stages={stages}
          users={users}
          permissions={permissions}
          actions={actions}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DraggableCard({
  lead,
  stages,
  users,
  permissions,
  actions,
  staleAfterDays,
}: {
  lead: KanbanLead;
  /** This card's own stage threshold — see isStale. */
  staleAfterDays: number | null;
  stages: KanbanStage[];
  users: { id: string; name: string }[];
  permissions: BoardPermissions;
  actions: LeadActionHandlers;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: lead.id });
  // No touch-action:none on the card: the TouchSensor's press-delay decides drag
  // vs scroll, so leaving native touch scrolling on lets the board/columns scroll.
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          {...listeners}
          {...attributes}
          className={cn("select-none outline-none focus-visible:ring-2 focus-visible:ring-primary", isDragging && "opacity-30")}
          aria-label={`${lead.name}. Right-click or press Shift+F10 for actions.`}
        >
          <LeadCard
            lead={lead}
            staleAfterDays={staleAfterDays}
            actions={
              <LeadActionsButton
                lead={lead}
                stages={stages}
                users={users}
                permissions={permissions}
                actions={actions}
              />
            }
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <LeadMenuItems
          kind="context"
          lead={lead}
          stages={stages}
          users={users}
          permissions={permissions}
          actions={actions}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Column({
  stage,
  stages,
  users,
  permissions,
  getActions,
}: {
  stage: KanbanStage;
  stages: KanbanStage[];
  users: { id: string; name: string }[];
  permissions: BoardPermissions;
  getActions: (lead: KanbanLead) => LeadActionHandlers;
}) {
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
        {/* Named by the registry, so a second remedy labels its own column
            instead of silently showing nothing. */}
        {remedyFor(stage.entryAction) && (
          <p className="mt-1.5 flex items-center gap-1 text-[10px] font-medium text-primary">
            <Zap className="size-3" />
            Requires {remedyFor(stage.entryAction)!.label.toLowerCase()}
          </p>
        )}
        {stage.automationRules.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="mt-1.5 w-fit cursor-help text-[10px] font-medium text-muted-foreground underline decoration-dotted underline-offset-2">
                {stage.automationRules.length} follow-up automation{stage.automationRules.length === 1 ? "" : "s"}
              </p>
            </TooltipTrigger>
            <TooltipContent>
              <ul className="space-y-1">
                {stage.automationRules.map((rule) => <li key={rule}>{rule}</li>)}
              </ul>
            </TooltipContent>
          </Tooltip>
        )}
      </header>
      <div
        className={cn(
          "min-h-[26rem] flex-1 space-y-2.5 p-2.5 transition-colors",
          isOver ? "bg-primary/[0.07] ring-1 ring-inset ring-primary/35" : "bg-background/20",
        )}
      >
        {stage.leads.map((lead) => (
          <DraggableCard
            key={lead.id}
            lead={lead}
            staleAfterDays={stage.staleAfterDays}
            stages={stages}
            users={users}
            permissions={permissions}
            actions={getActions(lead)}
          />
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
  users = [],
  permissions,
  currentUserId = null,
}: {
  stages: KanbanStage[];
  products?: { id: string; name: string }[];
  users?: { id: string; name: string }[];
  permissions: BoardPermissions;
  /** The signed-in user, so "Mine" can filter by ID rather than by name. */
  currentUserId?: string | null;
}) {
  const router = useRouter();
  const [stages, setStages] = useState(initial);
  const [activeLead, setActiveLead] = useState<KanbanLead | null>(null);
  const [pendingTd, setPendingTd] = useState<{ lead: KanbanLead; stageId: string } | null>(null);
  /**
   * A move waiting on the customer-link remedy.
   *
   * Opened because the SERVER said so — see requestMove. The board no longer
   * inspects `entryAction` to decide which dialog a stage needs.
   */
  const [pendingLink, setPendingLink] = useState<{
    lead: KanbanLead;
    stageId: string;
    stageName: string;
  } | null>(null);
  /**
   * A move the server will accept once a reason is typed — see requestMove.
   *
   * `testDrive` carries the booking details the person already filled in, so a
   * rule that asks for a reason on a test-drive stage does not throw that form
   * away and make them enter it twice.
   */
  const [pendingGate, setPendingGate] = useState<{
    lead: KanbanLead;
    stageId: string;
    stageName: string;
    verdict: StageGateVerdict;
    testDrive?: { productId: string | null; date: string; time: string; location: string };
    /** A customer already chosen for the link remedy, carried across the prompt. */
    contactId?: string;
  } | null>(null);
  const [pendingOutcome, setPendingOutcome] = useState<{ lead: KanbanLead; mode: "won" | "lost" } | null>(null);
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState<string>(OWNER_ANY);
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

  /**
   * Owners as {id, name}, deduped by ID.
   *
   * The filter used to hold a display NAME and compare `lead.assignee === owner`.
   * Names are labels: two people called "J. Smith" become one filter entry that
   * matches both, and renaming somebody silently empties the filter for whoever
   * had it applied.
   */
  const owners = useMemo(() => {
    const byId = new Map<string, string>();
    for (const stage of stages) {
      for (const lead of stage.leads) {
        if (lead.assignedToId) byId.set(lead.assignedToId, lead.assignee ?? "Unnamed");
      }
    }
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [stages]);

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
        // Filter on the ID. A display name is a label: two people called
        // "J. Smith" collide, and a rename silently empties the filter.
        const matchesOwner = matchesOwnerFilter(lead.assignedToId, owner);
        const needsAttention =
          !attentionOnly || lead.noNextStep || lead.nextStep?.overdue || isStale(lead.ageDays, stage.staleAfterDays);
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

  /**
   * Put the board back exactly as it was.
   *
   * The move is applied optimistically, which is right — the card should follow
   * the pointer. But a rejected move only raised a toast, so the card STAYED in
   * the column the server had refused to put it in. The board then showed a stage
   * the lead is not in, until something else happened to refresh it, and every
   * subsequent decision on that screen was made against a false position.
   *
   * Restoring the captured snapshot is the whole rollback: it is the state the
   * user had, so their scroll position, filters and selection are untouched.
   */
  function rollbackTo(snapshot: KanbanStage[], message: string) {
    setStages(snapshot);
    toast.error(message);
  }

  function requestMove(lead: KanbanLead, targetStageId: string, overrideReason?: string) {
    const fromStage = stages.find((stage) => stage.leads.some((item) => item.id === lead.id));
    const target = stages.find((stage) => stage.id === targetStageId);
    if (!fromStage || !target || fromStage.id === targetStageId) return;
    // NO CLIENT-SIDE INTERCEPTION ANY MORE.
    //
    // This used to check `target.entryAction === "book_test_drive"` and open the
    // booking dialog WITHOUT asking the server — so it could not know whether the
    // lead already had a booked drive, and every future remedy needed another
    // branch here. The server now evaluates the rule and names the remedy to
    // offer, if one is needed at all.
    //
    // Captured BEFORE the optimistic move, so a refusal restores what the user
    // was looking at rather than an approximation of it.
    const snapshot = stages;
    applyMove(lead.id, fromStage.id, targetStageId);
    startTransition(async () => {
      // A refused move — no permission for this pipeline, a stage that requires
      // booking details — comes back as `{ ok: false, error }`, the same shape
      // confirmTestDrive below already reads. The `.catch` is for the move never
      // reaching the server at all; the board must not keep a card in a column
      // the server never accepted, whichever way the attempt ended.
      const result = await moveLead(lead.id, targetStageId, overrideReason ? { overrideReason } : undefined).catch(
        // The same SHAPE as the action's own result, `gate` and `remedy`
        // included. Without them the union has a member missing those keys and
        // every read has to be guarded — a transport failure has no verdict and
        // no remedy, which is exactly what `undefined` says.
        () => ({ ok: false as const, error: "Couldn't move the lead", gate: undefined, remedy: undefined }),
      );

      // A STAGE RULE ASKING FOR A REASON IS A QUESTION, NOT A FAILURE.
      //
      // The server answers `{ ok: false, gate: { requiresReason: true } }` with no
      // `error`, because it is not refusing — it is asking. Without this branch
      // the board read the falsy `ok`, rolled back and said "Couldn't move the
      // lead", so a stage set to "ask for a reason" could not be entered at all,
      // and an owner could never move a lead past their own blocking rule (owners
      // hold every permission, so a block always resolves to the override path
      // for them).
      // A REMEDY THE SERVER OFFERED. Same shape as the reason prompt and for the
      // same reason: not a refusal, a next step. Which dialog to open comes from
      // the registry, so adding a remedy does not add a branch here.
      if (!result.ok && result.remedy) {
        setStages(snapshot);
        const remedy = STAGE_REMEDIES[result.remedy];
        if (remedy.dialog === "test_drive") setPendingTd({ lead, stageId: targetStageId });
        else setPendingLink({ lead, stageId: targetStageId, stageName: target.name });
        return;
      }
      if (!result.ok && result.gate?.requiresReason) {
        setStages(snapshot);
        setPendingGate({ lead, stageId: targetStageId, stageName: target.name, verdict: result.gate });
        return;
      }
      if (!result.ok) {
        rollbackTo(snapshot, result.error ?? "Couldn't move the lead");
        return;
      }
      // A `warn` gate lets the move through and exists to say what was missing.
      // Reported here rather than swallowed, or the warning lives only in the
      // audit trail — which is the one place the person who moved the card will
      // not look.
      if (result.gate?.mode === "warn" && result.gate.unmet.length > 0) {
        toast.warning(`Moved, but ${result.gate.unmet.map(describeUnmet).join("; ")}.`);
      }
    });
  }

  /** The customer-link remedy, from the picker. */
  function confirmContactLink(contactId: string) {
    if (!pendingLink) return;
    const { lead, stageId } = pendingLink;
    setPendingLink(null);
    submitContactLink(lead, stageId, contactId);
  }

  /**
   * Link-and-move, taking its target EXPLICITLY.
   *
   * Split for the same reason `submitTestDrive` is: the reason-retry calls it
   * directly, and reading `pendingLink` back out of state would mean
   * re-populating that state and waiting a frame for it to be visible.
   */
  function submitContactLink(
    lead: KanbanLead,
    stageId: string,
    contactId: string,
    overrideReason?: string,
  ) {
    const fromStage = stages.find((stage) => stage.leads.some((item) => item.id === lead.id));
    if (!fromStage) return;
    const target = stages.find((stage) => stage.id === stageId);
    const snapshot = stages;
    if (fromStage.id !== stageId) applyMove(lead.id, fromStage.id, stageId);
    startTransition(async () => {
      const result = await moveLeadWithContact(
        lead.id,
        stageId,
        contactId,
        overrideReason ? { overrideReason } : undefined,
      ).catch(() => ({ ok: false as const, error: "Couldn't link the customer", gate: undefined }));
      // A stage can want the link AND something else; the reason prompt carries
      // the chosen customer forward so the picker is not shown twice.
      if (!result.ok && result.gate?.requiresReason) {
        setStages(snapshot);
        setPendingGate({
          lead,
          stageId,
          stageName: target?.name ?? "this stage",
          verdict: result.gate,
          contactId,
        });
        return;
      }
      if (!result.ok) {
        rollbackTo(snapshot, result.error ?? "Couldn't link the customer");
        return;
      }
      toast.success(`Linked ${lead.name} to a customer`);
      router.refresh();
    });
  }

  /** Retry the move the server asked a reason for, this time carrying it. */
  function confirmGateOverride(reason: string) {
    if (!pendingGate) return;
    const { lead, stageId, testDrive, contactId } = pendingGate;
    setPendingGate(null);
    if (contactId) {
      // Re-send the customer they already chose, with the reason, rather than
      // showing the picker a second time.
      submitContactLink(lead, stageId, contactId, reason);
      return;
    }
    if (testDrive) {
      // Re-send the booking the person already filled in, with the reason,
      // rather than asking them to enter it a second time.
      submitTestDrive(lead, stageId, testDrive, reason);
      return;
    }
    requestMove(lead, stageId, reason);
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveLead(null);
    const leadId = String(event.active.id);
    const targetStageId = event.over ? String(event.over.id) : null;
    if (!targetStageId) return;
    const lead = stages.flatMap((stage) => stage.leads).find((item) => item.id === leadId);
    if (lead) requestMove(lead, targetStageId);
  }

  function confirmTestDrive(data: { productId: string | null; date: string; time: string; location: string }) {
    if (!pendingTd) return;
    const { lead, stageId } = pendingTd;
    setPendingTd(null);
    submitTestDrive(lead, stageId, data);
  }

  /**
   * The booking submit, taking its target EXPLICITLY.
   *
   * Split out of `confirmTestDrive` so the reason-retry can call it directly.
   * Reading `pendingTd` from state would have meant re-populating that state and
   * then waiting a frame for it to be visible — a timing hack in place of an
   * argument.
   */
  function submitTestDrive(
    lead: KanbanLead,
    stageId: string,
    data: { productId: string | null; date: string; time: string; location: string },
    overrideReason?: string,
  ) {
    const fromStage = stages.find((stage) => stage.leads.some((item) => item.id === lead.id));
    if (!fromStage) return;
    const target = stages.find((stage) => stage.id === stageId);
    const snapshot = stages;
    if (fromStage.id !== stageId) applyMove(lead.id, fromStage.id, stageId);
    startTransition(async () => {
      const result = await moveLeadToTestDrive(
        lead.id,
        stageId,
        data,
        overrideReason ? { overrideReason } : undefined,
      ).catch(() => ({ ok: false as const, error: "Something went wrong", gate: undefined }));
      // A stage can carry BOTH a booking requirement and a rule, so this path
      // gets the same reason prompt as a plain drag — carrying the booking
      // details forward, rather than discarding a form the person just filled in.
      if (!result.ok && result.gate?.requiresReason) {
        setStages(snapshot);
        setPendingGate({
          lead,
          stageId,
          stageName: target?.name ?? "this stage",
          verdict: result.gate,
          testDrive: data,
        });
        return;
      }
      if (result.ok) {
        toast.success(`Test drive ${lead.testDrive ? "rescheduled" : "booked"} for ${lead.name}`, {
          description: `${data.date} at ${data.time}${data.location ? ` · ${data.location}` : ""}`,
        });
      } else {
        // Same rule: a refused booking must not leave the card in the stage the
        // booking was the price of entry to.
        rollbackTo(snapshot, result.error ?? "Couldn't book the test drive");
      }
    });
  }

  function removeLead(leadId: string) {
    setStages((previous) =>
      previous.map((stage) => ({ ...stage, leads: stage.leads.filter((lead) => lead.id !== leadId) })),
    );
  }

  function getActions(lead: KanbanLead): LeadActionHandlers {
    return {
      open: () => router.push(`/leads/${lead.id}`),
      schedule: () => router.push(`/leads/${lead.id}?tab=activities&schedule=1`),
      move: (stageId) => requestMove(lead, stageId),
      assign: (userId) => {
        const user = users.find((item) => item.id === userId);
        if (!user) return;
        startTransition(async () => {
          const result = await assignLead(lead.id, userId).catch(() => ({
            ok: false as const,
            error: "Something went wrong",
          }));
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          setStages((previous) =>
            previous.map((stage) => ({
              ...stage,
              leads: stage.leads.map((item) =>
                item.id === lead.id ? { ...item, assignedToId: user.id, assignee: user.name } : item,
              ),
            })),
          );
          toast.success(`Assigned to ${user.name}`);
        });
      },
      testDrive: () => {
        const stage = stages.find((item) => item.entryAction === "book_test_drive");
        if (stage) setPendingTd({ lead, stageId: stage.id });
      },
      won: () => setPendingOutcome({ lead, mode: "won" }),
      lost: () => setPendingOutcome({ lead, mode: "lost" }),
      copyLink: () => {
        void navigator.clipboard
          .writeText(`${window.location.origin}/leads/${lead.id}`)
          .then(() => toast.success("Lead link copied"))
          .catch(() => toast.error("Couldn't copy the lead link"));
      },
      addToContacts: () => {
        startTransition(async () => {
          const result = await convertLeadToContact(lead.id).catch(() => ({
            ok: false as const,
            error: "Something went wrong",
          }));
          if (result.ok) {
            setStages((previous) =>
              previous.map((stage) => ({
                ...stage,
                leads: stage.leads.map((item) =>
                  item.id === lead.id ? { ...item, contactId: result.contactId } : item,
                ),
              })),
            );
            toast.success(`${lead.name} added to contacts`);
          } else {
            toast.error(result.error ?? "Couldn't add to contacts");
          }
        });
      },
    };
  }

  function confirmOutcome(reason?: string) {
    if (!pendingOutcome) return;
    const { lead, mode } = pendingOutcome;
    setPendingOutcome(null);
    startTransition(async () => {
      try {
        const formData = new FormData();
        if (mode === "won") {
          formData.set("returnTo", "/leads");
          await markWon(lead.id, formData);
        } else {
          formData.set("lostReason", reason ?? "");
          await markLost(lead.id, formData);
        }
        removeLead(lead.id);
        toast.success(`${lead.name} marked ${mode}`);
      } catch {
        toast.error(`Couldn't mark ${lead.name} ${mode}`);
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
              <option value={OWNER_ANY}>All owners</option>
              {currentUserId && <option value={currentUserId}>Mine</option>}
              <option value={OWNER_UNASSIGNED}>Unassigned</option>
              {owners.length > 0 && <option disabled>──────────</option>}
              {owners.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
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
            {/*
              The filter and the list are different tools and both are kept.
              Filtering answers "show me only these cards, in their columns"; the
              Attention Centre answers "what should I do next, across every
              stage, and why" — which a filter structurally cannot, because it can
              neither rank nor explain.

              A LINK rather than a replacement: the board's toggle is still the
              right thing when you want to keep the spatial view.
            */}
            <Link href="/leads/attention" className="btn-secondary h-10">
              <ListChecks className="size-4" />
              Attention list
            </Link>
            {(query || owner !== OWNER_ANY || attentionOnly) && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setOwner(OWNER_ANY);
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
            <Column
              key={stage.id}
              stage={stage}
              stages={stages}
              users={users}
              permissions={permissions}
              getActions={getActions}
            />
          ))}
        </div>
        <DragOverlay>{activeLead && <LeadCard lead={activeLead} dragging />}</DragOverlay>

        <TestDriveDialog
          pending={pendingTd}
          products={products}
          onCancel={() => setPendingTd(null)}
          onConfirm={confirmTestDrive}
        />
        <LeadOutcomeDialog
          key={pendingOutcome ? `${pendingOutcome.lead.id}-${pendingOutcome.mode}` : "closed"}
          pending={pendingOutcome}
          onCancel={() => setPendingOutcome(null)}
          onConfirm={confirmOutcome}
        />
        <ContactLinkDialog
          key={pendingLink ? `${pendingLink.lead.id}-${pendingLink.stageId}` : "link-closed"}
          pending={pendingLink}
          onCancel={() => setPendingLink(null)}
          onConfirm={confirmContactLink}
        />
        <StageRuleReasonDialog
          key={pendingGate ? `${pendingGate.lead.id}-${pendingGate.stageId}` : "gate-closed"}
          pending={pendingGate}
          onCancel={() => setPendingGate(null)}
          onConfirm={confirmGateOverride}
        />
      </DndContext>
    </>
  );
}

/**
 * The `link_contact` remedy's picker.
 *
 * A SEARCH, not a list. The lead detail page renders every contact into a
 * `<select>`, which is fine on a page loaded for one lead and wrong on a board —
 * it would ship the whole customer table to the browser on every render, for a
 * dialog most people never open.
 */
function ContactLinkDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: { lead: KanbanLead; stageId: string; stageName: string } | null;
  onCancel: () => void;
  onConfirm: (contactId: string) => void;
}) {
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<Array<{ id: string; label: string; sublabel: string }>>([]);
  const [searching, setSearching] = useState(false);
  const latest = useRef("");

  useEffect(() => {
    const query = term.trim();
    latest.current = query;
    if (query.length < 2) return;
    const timer = setTimeout(() => {
      setSearching(true);
      searchLinkableContacts(query)
        .then((results) => {
          // A newer keystroke owns the box; an older answer must not repaint it.
          if (latest.current === query) setRows(results);
        })
        .catch(() => {
          if (latest.current === query) setRows([]);
        })
        .finally(() => {
          if (latest.current === query) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [term]);

  const searchable = term.trim().length >= 2;

  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && onCancel()}>
      <ResponsiveDialogContent className="sm:max-w-md">
        {pending && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UserRound className="size-4 text-primary" />
                Link a customer
              </DialogTitle>
              <DialogDescription>
                <span className="font-medium text-foreground">{pending.lead.name}</span> needs a linked
                customer before it can enter {pending.stageName}.
              </DialogDescription>
            </DialogHeader>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Find a customer</label>
              <input
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                className="input"
                autoFocus
                placeholder="Name, company, email or phone"
              />
            </div>

            <div className="max-h-64 space-y-1 overflow-y-auto">
              {!searchable && (
                <p className="px-1 text-xs text-muted-foreground">Type at least two characters.</p>
              )}
              {searchable && searching && rows.length === 0 && (
                <p className="px-1 text-xs text-muted-foreground">Searching…</p>
              )}
              {searchable && !searching && rows.length === 0 && (
                <p className="px-1 text-xs text-muted-foreground">No customers match that.</p>
              )}
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => onConfirm(row.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left text-sm hover:border-primary/40 hover:bg-primary/5"
                >
                  <span className="truncate font-medium">{row.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{row.sublabel}</span>
                </button>
              ))}
            </div>

            <div className="flex justify-end">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </ResponsiveDialogContent>
    </Dialog>
  );
}

/**
 * The move the server will accept once somebody says why.
 *
 * Opened when a verdict comes back with `requiresReason` — a stage set to "ask
 * for a reason", or a `block` a holder of `leads.override_stage_rules` (or the
 * owner, who holds everything) is allowed to pass. It is NOT a refusal dialog:
 * the server has already decided the move may proceed, and is asking for the
 * record it will keep.
 *
 * The unmet criteria are listed rather than summarised, because the reason being
 * typed is meant to answer them, and it is written to `AuditEvent`, which cannot
 * be edited afterwards.
 */
function StageRuleReasonDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: { lead: KanbanLead; stageId: string; stageName: string; verdict: StageGateVerdict } | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const enough = reason.trim().length >= MIN_OVERRIDE_REASON;

  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && onCancel()}>
      <ResponsiveDialogContent className="sm:max-w-md">
        {pending && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="size-4 text-amber-400" />
                {pending.verdict.mode === "block" ? "Override the stage rule?" : "Why is this moving now?"}
              </DialogTitle>
              <DialogDescription>
                <span className="font-medium text-foreground">{pending.lead.name}</span>
                {pending.verdict.direction === "exit"
                  ? " does not meet the rule for leaving this stage"
                  : ` does not meet the rule for entering ${pending.stageName}`}
                {pending.verdict.mode === "block"
                  ? " — you can move it anyway because of your role, and the reason is recorded."
                  : " — record why it is moving anyway."}
              </DialogDescription>
            </DialogHeader>

            <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
              {pending.verdict.unmet.map((unmet, index) => (
                <li key={index}>⚠ {describeUnmet(unmet)}</li>
              ))}
            </ul>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Reason</label>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="input"
                autoFocus
                placeholder="e.g. Quote is being drafted, customer confirmed by phone"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && enough) onConfirm(reason.trim());
                }}
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {enough
                  ? "Recorded against this lead's history."
                  : `At least ${MIN_OVERRIDE_REASON} characters — this goes into the audit trail.`}
              </span>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="button" disabled={!enough} onClick={() => onConfirm(reason.trim())}>
                Move anyway
              </Button>
            </div>
          </>
        )}
      </ResponsiveDialogContent>
    </Dialog>
  );
}

function LeadOutcomeDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: { lead: KanbanLead; mode: "won" | "lost" } | null;
  onCancel: () => void;
  onConfirm: (reason?: string) => void;
}) {
  const [reason, setReason] = useState("");

  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && onCancel()}>
      <ResponsiveDialogContent className="sm:max-w-md">
        {pending && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {pending.mode === "won" ? (
                  <Trophy className="size-4 text-emerald-400" />
                ) : (
                  <XCircle className="size-4 text-destructive" />
                )}
                Mark {pending.lead.name} {pending.mode}?
              </DialogTitle>
              <DialogDescription>
                {pending.mode === "won"
                  ? "This closes the opportunity as won and creates a customer if one is not already linked."
                  : "Capture why the opportunity was lost so reporting and future coaching stay useful."}
              </DialogDescription>
            </DialogHeader>
            {pending.mode === "lost" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Lost reason</label>
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="input"
                  autoFocus
                  placeholder="e.g. Bought elsewhere, budget, no response"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && reason.trim()) onConfirm(reason.trim());
                  }}
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                type="button"
                variant={pending.mode === "lost" ? "destructive" : "default"}
                disabled={pending.mode === "lost" && !reason.trim()}
                onClick={() => onConfirm(reason.trim() || undefined)}
              >
                Mark {pending.mode}
              </Button>
            </div>
          </>
        )}
      </ResponsiveDialogContent>
    </Dialog>
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
                {pending.lead.testDrive ? "Reschedule the test drive" : "Book the test drive"}
              </DialogTitle>
              <DialogDescription>
                <span className="font-medium text-foreground">{pending.lead.name}</span>
                {pending.lead.testDrive
                  ? " already has a planned test drive. Update the appointment details below."
                  : " is moving to test drive — capture the details so the appointment isn't lost."}
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
