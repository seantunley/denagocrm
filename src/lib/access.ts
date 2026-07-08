/**
 * Module gating. Admins (role "owner") see everything; everyone else gets the
 * modules ticked on their user. Module claims ride in the session JWT, so a
 * change takes effect at the user's next sign-in (72h max).
 */
export const MODULES = [
  { id: "crm", label: "CRM", desc: "Leads, quotes, deliveries, referrals, activities, calendar" },
  { id: "workshop", label: "Workshop", desc: "Vehicles, job cards, workshop calendar" },
  { id: "reports", label: "Reports", desc: "Sales & service reporting" },
  { id: "inbox", label: "Social Inbox", desc: "WhatsApp / Messenger / Instagram conversations" },
] as const;

export type ModuleId = (typeof MODULES)[number]["id"];

export function parseModules(csv: string | null | undefined): Set<string> {
  return new Set((csv ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

export function hasModule(
  user: { role: string; modules: string },
  module: ModuleId
): boolean {
  if (user.role === "owner") return true;
  return parseModules(user.modules).has(module);
}

/** Contacts are shared: anyone with CRM or Workshop can see them. */
export function canSeeContacts(user: { role: string; modules: string }): boolean {
  return hasModule(user, "crm") || hasModule(user, "workshop");
}

/** First route prefix match wins. "contacts" = crm OR workshop; "admin" = owners. */
export const ROUTE_GATES: { prefix: string; gate: ModuleId | "contacts" | "admin" }[] = [
  { prefix: "/leads", gate: "crm" },
  { prefix: "/quotes", gate: "crm" },
  { prefix: "/deliveries", gate: "crm" },
  { prefix: "/stock", gate: "crm" },
  { prefix: "/referrals", gate: "crm" },
  { prefix: "/activities", gate: "crm" },
  { prefix: "/calendar", gate: "crm" },
  { prefix: "/duplicates", gate: "crm" },
  { prefix: "/automations", gate: "admin" },
  { prefix: "/products", gate: "admin" },
  { prefix: "/library", gate: "crm" },
  { prefix: "/contacts", gate: "contacts" },
  { prefix: "/vehicles", gate: "workshop" },
  { prefix: "/jobcards", gate: "workshop" },
  { prefix: "/workshop-calendar", gate: "workshop" },
  { prefix: "/reports", gate: "reports" },
  { prefix: "/inbox", gate: "inbox" },
  { prefix: "/trash", gate: "admin" },
];

export function routeAllowed(
  pathname: string,
  claims: { role: string; modules: string }
): boolean {
  const rule = ROUTE_GATES.find(
    (r) => pathname === r.prefix || pathname.startsWith(r.prefix + "/")
  );
  if (!rule) return true;
  if (claims.role === "owner") return true;
  if (rule.gate === "admin") return false;
  if (rule.gate === "contacts") return canSeeContacts(claims);
  return hasModule(claims, rule.gate);
}
