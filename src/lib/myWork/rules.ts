/**
 * My Work — one list of what is waiting on ME, from every area (brief
 * denagocrm-intelligent-workspaces-revised.md §6; Sean, 2026-11-24: "All of them").
 * Pure: the loader (load.ts) turns real records into WorkItems and this file only
 * sorts them. There is no task table of its own — each item IS its record, and
 * doing the work there is what clears it.
 */
import { johannesburgDateKey } from "@/lib/activityDay";

export const WORK_AREAS = ["Sales", "Workshop", "Deliveries", "Approvals", "Support"] as const;
export type WorkArea = (typeof WORK_AREAS)[number];

export const WORK_BUCKETS = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Coming up" },
  { key: "undated", label: "No date" },
  { key: "waiting", label: "Waiting on someone else" },
] as const;
export type WorkBucket = (typeof WORK_BUCKETS)[number]["key"];

export type WorkItem = {
  area: WorkArea;
  /** The record this is about. `${type}:${id}` is the item's one identity — the dedupe key. */
  source: { type: "lead" | "activity" | "quote" | "delivery" | "jobcard" | "case" | "approval"; id: string };
  /** A task someone set (it stays until done) or a suggestion worked out from the record (it goes when the record changes). */
  kind: "task" | "suggestion";
  title: string;
  /** Why it is on my list, in plain words. */
  reason: string;
  /** When it is due. Null = no date (a case, an approval) — still mine, just undated. */
  due: Date | null;
  /** An all-day item is overdue only once its day has passed, not at midnight's first minute. */
  allDay?: boolean;
  /** Mine, but the next move is someone else's (the customer's, a signer's). */
  waiting?: boolean;
  urgent?: boolean;
  /** Where the work is done. */
  href: string;
};

export const workKey = (item: Pick<WorkItem, "source">) => `${item.source.type}:${item.source.id}`;

export function bucketOf(item: Pick<WorkItem, "due" | "allDay" | "waiting">, now: Date): WorkBucket {
  if (item.waiting) return "waiting";
  if (!item.due) return "undated";
  const day = johannesburgDateKey(item.due);
  const today = johannesburgDateKey(now);
  if (day < today) return "overdue";
  if (day > today) return "upcoming";
  // Today: a timed item whose time has gone is already late.
  return !item.allDay && item.due < now ? "overdue" : "today";
}

/** Grouped by bucket, one row per record; inside each, urgent first, then soonest, then by area. */
export function groupWork(items: WorkItem[], now: Date): Record<WorkBucket, WorkItem[]> {
  const seen = new Set<string>();
  const groups: Record<WorkBucket, WorkItem[]> = { overdue: [], today: [], upcoming: [], undated: [], waiting: [] };
  for (const item of items) {
    if (seen.has(workKey(item))) continue;
    seen.add(workKey(item));
    groups[bucketOf(item, now)].push(item);
  }
  const area = (a: WorkArea) => WORK_AREAS.indexOf(a);
  for (const list of Object.values(groups)) {
    list.sort(
      (a, b) =>
        Number(Boolean(b.urgent)) - Number(Boolean(a.urgent)) ||
        (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity) ||
        area(a.area) - area(b.area),
    );
  }
  return groups;
}
