// Shared, client-safe help-desk vocabulary. No server-only imports so both
// server queries and client components can use these.

export type StatusGroup = "open" | "pending" | "closed";
export type PillTone = "neutral" | "info" | "success" | "danger" | "warning";

export type StatusMeta = {
  value: string;
  label: string;
  group: StatusGroup;
  tone: PillTone;
  /** Ordering weight in the inbox (lower = higher up). */
  weight: number;
};

// Canonical ticket state machine. Superset kept compatible with the legacy
// values already written by portal/staff code (new, open, waiting_*, resolved,
// closed, cancelled).
export const STATUSES: StatusMeta[] = [
  { value: "new", label: "New", group: "open", tone: "info", weight: 0 },
  { value: "open", label: "Open", group: "open", tone: "info", weight: 1 },
  { value: "waiting_internal", label: "Waiting on us", group: "open", tone: "warning", weight: 2 },
  { value: "waiting_customer", label: "Pending customer", group: "pending", tone: "neutral", weight: 3 },
  { value: "resolved", label: "Resolved", group: "closed", tone: "success", weight: 4 },
  { value: "closed", label: "Closed", group: "closed", tone: "neutral", weight: 5 },
  { value: "cancelled", label: "Cancelled", group: "closed", tone: "neutral", weight: 6 },
];

export const STATUS_VALUES = STATUSES.map((s) => s.value);
export const statusMeta = (value: string): StatusMeta =>
  STATUSES.find((s) => s.value === value) ?? { value, label: value, group: "open", tone: "neutral", weight: 9 };
export const isOpenStatus = (value: string) => statusMeta(value).group !== "closed";

export type PriorityMeta = { value: string; label: string; tone: PillTone; weight: number };
export const PRIORITIES: PriorityMeta[] = [
  { value: "urgent", label: "Urgent", tone: "danger", weight: 0 },
  { value: "high", label: "High", tone: "warning", weight: 1 },
  { value: "normal", label: "Normal", tone: "neutral", weight: 2 },
  { value: "low", label: "Low", tone: "neutral", weight: 3 },
];
export const PRIORITY_VALUES = PRIORITIES.map((p) => p.value);
export const priorityMeta = (value: string): PriorityMeta =>
  PRIORITIES.find((p) => p.value === value) ?? { value, label: value, tone: "neutral", weight: 5 };

// Ticket "type" doubles as the top-level category / intent.
export const TICKET_TYPES = ["support", "warranty", "delivery", "billing", "sales", "other"] as const;

export type Folder = "unassigned" | "mine" | "open" | "pending" | "closed" | "all";
export const FOLDERS: { key: Folder; label: string }[] = [
  { key: "unassigned", label: "Unassigned" },
  { key: "mine", label: "Assigned to me" },
  { key: "open", label: "Open" },
  { key: "pending", label: "Pending" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

/** Message thread kinds. customer/staff are public; note/event are staff-only. */
export type ThreadType = "customer" | "staff" | "note" | "event";
export const PUBLIC_THREAD_TYPES: ThreadType[] = ["customer", "staff"];
