/**
 * Snooze and dismiss on My Work (brief §6: "support snooze … dismissal where
 * appropriate"; "completion must update the authoritative source … not merely hide
 * an unresolved obligation"). Pure — the table is WorkDisposition, the action is
 * app/actions/myWork.ts.
 *
 *  - SNOOZE hides an item from MY list until a day I pick. It changes nothing on the
 *    record: a snoozed task is still due, still overdue elsewhere, and comes back.
 *  - DISMISS is only for a SUGGESTION (worked out from a record, not set by anyone):
 *    "not this one". It comes back when its reason changes — a new reason is a new
 *    suggestion — or after DISMISS_DAYS. A task can never be dismissed: the only way
 *    off the list is doing it on its record.
 */
import { johannesburgStartOfDay } from "@/lib/activityDay";
import { workKey, type WorkItem } from "./rules";

export const SNOOZE_CHOICES = [
  { days: 1, label: "Until tomorrow" },
  { days: 3, label: "For 3 days" },
  { days: 7, label: "For a week" },
] as const;
export const DISMISS_DAYS = 30;

/** Sources whose items are suggestions — the only ones that may be dismissed. */
export const DISMISSABLE_SOURCES = new Set<WorkItem["source"]["type"]>(["lead", "quote"]);

export type Disposition = { itemKey: string; action: string; until: Date; fingerprint: string | null };

const DAY = 24 * 60 * 60 * 1000;

/** Snoozed for N days = back at the start of that Johannesburg day, not at this time of day. */
export function snoozeUntil(days: number, now: Date): Date {
  return new Date(johannesburgStartOfDay(now).getTime() + days * DAY);
}

export function dismissUntil(now: Date): Date {
  return new Date(now.getTime() + DISMISS_DAYS * DAY);
}

/** An item key a person may set a disposition on: `<source>:<id>`, nothing else. */
export function parseItemKey(raw: unknown): { type: WorkItem["source"]["type"]; key: string } | null {
  const key = String(raw ?? "");
  const match = /^(lead|activity|quote|delivery|jobcard|case|approval):([A-Za-z0-9_-]{1,64})$/.exec(key);
  return match ? { type: match[1] as WorkItem["source"]["type"], key } : null;
}

/** My list with my dispositions applied: what to show, and what is snoozed (to bring back). */
export function applyDispositions<T extends WorkItem>(items: T[], dispositions: Disposition[], now: Date) {
  const live = new Map(dispositions.filter((d) => d.until > now).map((d) => [d.itemKey, d]));
  const shown: T[] = [];
  const snoozed: (T & { until: Date })[] = [];
  for (const item of items) {
    const d = live.get(workKey(item));
    if (d?.action === "snoozed") snoozed.push({ ...item, until: d.until });
    // Dismissed holds only for a suggestion whose reason is unchanged.
    else if (d?.action === "dismissed" && item.kind === "suggestion" && d.fingerprint === item.reason) continue;
    else shown.push(item);
  }
  return { shown, snoozed };
}
