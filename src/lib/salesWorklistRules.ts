/**
 * The leads list as a WORKLIST (brief denagocrm-intelligent-workspaces-revised.md §2):
 * built-in views a rep works from, on the same leads the board shows. Pure — the
 * page (leads/list) applies these and salesWorklist.ts loads the ranked views.
 *
 * "My priorities" and "At risk" are ranked lists that already exist (Today's lead
 * score and the Attention Centre), so they are id lists, not filters here.
 */
import type { Prisma } from "@prisma/client";
import { johannesburgStartOfDay } from "@/lib/activityDay";

export const WORKLIST_VIEWS = [
  { key: "priorities", label: "My priorities", hint: "Your open deals most worth contacting, best first — the Today ranking." },
  { key: "overdue", label: "Overdue", hint: "Open deals with a planned activity past its time." },
  { key: "today", label: "Today", hint: "Open deals with a planned activity due today." },
  { key: "atrisk", label: "At risk", hint: "Open deals the Attention Centre says need acting on, with the reason." },
  { key: "waiting", label: "Waiting", hint: "Open deals with a quote sent and not signed yet." },
  { key: "nurture", label: "Nurturing", hint: "Deals parked for later, until their review date." },
  { key: "unassigned", label: "Unassigned", hint: "Open deals with no owner." },
  { key: "all", label: "All opportunities", hint: "Every deal you can see, any status." },
] as const;
export type WorklistView = (typeof WORKLIST_VIEWS)[number]["key"];

export const WORKLIST_SORTS = [
  // Ranked views: best first. The others: newest first, as the list always was.
  { key: "", label: "Default order" },
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "value", label: "Highest value" },
  { key: "stage", label: "Longest in stage" },
] as const;
export type WorklistSort = (typeof WORKLIST_SORTS)[number]["key"];

/**
 * Which view a URL means. No `show` and no other filter = My priorities (the
 * worklist's default); no `show` but filters = All, so a link or saved view made
 * before views existed still shows exactly what it did.
 */
export function worklistView(show: string | undefined, hasOtherFilters: boolean): WorklistView {
  const known = WORKLIST_VIEWS.find((view) => view.key === show);
  if (known) return known.key;
  return hasOtherFilters ? "all" : "priorities";
}

export function worklistSort(sort: string | undefined): WorklistSort {
  return WORKLIST_SORTS.find((option) => option.key === sort)?.key ?? "";
}

const DAY = 24 * 60 * 60 * 1000;
const planned = { status: "planned", availabilityBlock: false } as const;

/** The filter a non-ranked view adds; ranked views return {} and are narrowed by id. */
export function worklistWhere(view: WorklistView, now: Date): Prisma.LeadWhereInput {
  switch (view) {
    case "overdue":
      return { status: "open", activities: { some: { ...planned, dueDate: { lt: now } } } };
    case "today": {
      const start = johannesburgStartOfDay(now);
      return { status: "open", activities: { some: { ...planned, dueDate: { gte: start, lt: new Date(start.getTime() + DAY) } } } };
    }
    case "waiting":
      return { status: "open", quotes: { some: { status: "sent", signedAt: null, supersededAt: null, deletedAt: null } } };
    case "nurture":
      return { status: "nurture" };
    case "unassigned":
      return { status: "open", assignedToId: null };
    case "priorities":
    case "atrisk":
      return { status: "open" };
    case "all":
      return {};
  }
}

export function worklistOrderBy(sort: WorklistSort): Prisma.LeadOrderByWithRelationInput[] {
  switch (sort) {
    case "oldest":
      return [{ createdAt: "asc" }, { id: "asc" }];
    case "value":
      return [{ valueCents: "desc" }, { id: "desc" }];
    case "stage":
      return [{ stageEnteredAt: "asc" }, { id: "asc" }];
    default:
      return [{ createdAt: "desc" }, { id: "desc" }];
  }
}

/** The Attention Centre's band in words. No band = nothing wrong found. */
export const HEALTH: Record<string, { label: string; tone: "success" | "info" | "warning" | "danger" }> = {
  none: { label: "Healthy", tone: "success" },
  watch: { label: "Watch", tone: "info" },
  act: { label: "Needs action", tone: "warning" },
  urgent: { label: "At risk", tone: "danger" },
};

/**
 * How soon this deal needs a move, from facts: the Attention Centre says urgent or
 * its next step is late → High; it says act, its next step is today, or nothing is
 * planned at all → Medium; otherwise Low.
 */
export function urgencyOf(band: string | undefined, next: { dueDate: Date; allDay: boolean } | undefined, now: Date, todayEnd: Date): "High" | "Medium" | "Low" {
  const late = next ? (next.allDay ? next.dueDate < new Date(todayEnd.getTime() - DAY) : next.dueDate < now) : false;
  if (band === "urgent" || late) return "High";
  if (band === "act" || !next || next.dueDate < todayEnd) return "Medium";
  return "Low";
}

/** Whole days since `since`, for "in stage 12 d". */
export function daysSince(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY));
}
