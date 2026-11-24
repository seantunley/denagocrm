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
  /** A suggestion's proof (brief §7): the record and date its reason was read from. */
  evidence?: { label: string; href: string };
  /** What a dismissal is held against; defaults to the reason. */
  fingerprint?: string;
};

export const workKey = (item: Pick<WorkItem, "source">) => `${item.source.type}:${item.source.id}`;

/**
 * The reason a dismissal is held against, with its numbers taken out: "no contact
 * for 12 days" tomorrow is "13 days" — the same reason, not a new one. A different
 * reason (a reply came in, the stage moved) is a new suggestion and shows again.
 */
export const fingerprintOf = (item: Pick<WorkItem, "reason" | "fingerprint">) => (item.fingerprint ?? item.reason).replace(/\d+/g, "#");

/**
 * An activity of mine can sit on a lead or contact I may not open (Activities
 * granted, Leads/Contacts not, or someone else's deal). The row then opens
 * Activities, where the task itself is done — never a page that turns me away.
 * `null` = may open any.
 */
export function activityHref(row: { leadId: string | null; contactId: string | null }, leads: Set<string> | null, contacts: Set<string> | null): string {
  const may = (set: Set<string> | null, id: string) => set === null || set.has(id);
  if (row.leadId && may(leads, row.leadId)) return `/leads/${row.leadId}`;
  if (row.contactId && may(contacts, row.contactId)) return `/contacts/${row.contactId}`;
  return "/activities";
}

/** The queue draws this many rows by default; the counts above it always cover everything. */
export const QUEUE_ROWS = 100;

/** The row's button: what doing it means for that kind of record. */
export const ACTION_LABEL: Record<WorkItem["source"]["type"], string> = {
  lead: "Contact",
  activity: "Do it",
  quote: "Chase",
  delivery: "Plan",
  jobcard: "Open",
  case: "Reply",
  approval: "Approve",
};

/** How pressing it is, from facts: urgent flag, then how late. */
export function priorityOf(item: WorkItem, bucket: WorkBucket): "High" | "Medium" | "Low" {
  if (item.urgent || bucket === "overdue") return "High";
  if (bucket === "today") return "Medium";
  return "Low";
}

/** One list, most pressing first: overdue, today, coming up, undated, then waiting on others. */
export function rankWork(items: WorkItem[], now: Date): (WorkItem & { bucket: WorkBucket })[] {
  const groups = groupWork(items, now);
  return WORK_BUCKETS.flatMap((bucket) => groups[bucket.key].map((item) => ({ ...item, bucket: bucket.key })));
}

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
