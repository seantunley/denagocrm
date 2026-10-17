export const customerHistoryFilters = [
  { key: "all", label: "All" },
  { key: "email", label: "Email" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "call", label: "Calls" },
  { key: "note", label: "Notes" },
  { key: "activity", label: "Activities" },
  { key: "audit", label: "Changes" },
] as const;

export type CustomerHistoryFilter = (typeof customerHistoryFilters)[number]["key"];

/**
 * Audit lines that only repeat an entry already in the history — "Sent email to
 * …" beside the email itself, "Scheduled …" beside the activity. Shown under
 * Changes, not in All, where every email appeared twice.
 */
export const MIRRORED_AUDIT_ACTIONS: ReadonlySet<string> = new Set(["email.sent", "whatsapp.sent", "activity.scheduled", "activity.logged", "activity.done"]);

/** The history entry type of an audit line. */
export const auditEntryType = (action: string) => (MIRRORED_AUDIT_ACTIONS.has(action) ? "audit-mirror" : "audit");

export function matchesCustomerHistoryFilter(type: string, filter: CustomerHistoryFilter): boolean {
  if (type === "audit-mirror") return filter === "audit";
  return filter === "all" || type === filter;
}

/** How many entries show at first, and how many more each "Show older" adds. */
export const CUSTOMER_HISTORY_PAGE = 30;

/** Match the CRM's date display; browser timezone must not split one day into two groups. */
export function customerHistoryDay(date: Date): string {
  return new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric", month: "long", year: "numeric" }).format(date);
}
