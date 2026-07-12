/**
 * Legacy module flags remain for screens that have not yet moved to the
 * database-backed permission catalogue. Migrated routes are intentionally
 * absent and enforce access in server layouts/actions instead.
 */
export const MODULES = [
  { id: "crm", label: "CRM", desc: "Legacy fallback for remaining CRM screens" },
  { id: "workshop", label: "Workshop", desc: "Legacy fallback for remaining workshop screens" },
  { id: "reports", label: "Reports", desc: "Legacy fallback for remaining reporting screens" },
  { id: "inbox", label: "Social Inbox", desc: "Legacy fallback for social integrations" },
] as const;

export type ModuleId = (typeof MODULES)[number]["id"];

export function parseModules(csv: string | null | undefined): Set<string> {
  return new Set((csv ?? "").split(",").map((item) => item.trim()).filter(Boolean));
}

export function hasModule(user: { role: string; modules: string }, module: ModuleId): boolean {
  if (user.role === "owner") return true;
  return parseModules(user.modules).has(module);
}

export function canSeeContacts(user: { role: string; modules: string }): boolean {
  return hasModule(user, "crm") || hasModule(user, "workshop");
}

/**
 * Only non-migrated or deliberately owner-only surfaces remain here. All core
 * CRM, document, case, marketing, workshop, reporting and inbox routes now use
 * database-backed permission layouts and record scopes.
 */
export const ROUTE_GATES: { prefix: string; gate: ModuleId | "contacts" | "admin" }[] = [
  { prefix: "/stock", gate: "crm" },
  { prefix: "/referrals", gate: "crm" },
  { prefix: "/health", gate: "crm" },
  { prefix: "/automations", gate: "admin" },
  { prefix: "/chatbot", gate: "admin" },
  { prefix: "/bot-builder", gate: "admin" },
  { prefix: "/products", gate: "admin" },
  { prefix: "/trash", gate: "admin" },
];

export function routeAllowed(
  pathname: string,
  claims: { role: string; modules: string }
): boolean {
  const rule = ROUTE_GATES.find(
    (item) => pathname === item.prefix || pathname.startsWith(item.prefix + "/")
  );
  if (!rule) return true;
  if (claims.role === "owner") return true;
  if (rule.gate === "admin") return false;
  if (rule.gate === "contacts") return canSeeContacts(claims);
  return hasModule(claims, rule.gate);
}
