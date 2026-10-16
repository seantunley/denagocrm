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

export function matchesCustomerHistoryFilter(type: string, filter: CustomerHistoryFilter): boolean {
  return filter === "all" || type === filter;
}

/** Match the CRM's date display; browser timezone must not split one day into two groups. */
export function customerHistoryDay(date: Date): string {
  return new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric", month: "long", year: "numeric" }).format(date);
}
