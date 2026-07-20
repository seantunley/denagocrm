// ─────────────────────────────────────────────────────────────────────────
// Module registry — Path A, Phase 1.
//
// The single declarative source of truth for the app's feature "packs". Turning
// DenagoCRM into a configurable product means the CRM *core* is always present
// and everything else (the social inbox, help desk, marketing, automation, and
// the automotive/commerce verticals) is an optional pack a tenant can switch off.
//
// Phase 1 is deliberately behaviour-preserving: every module ships enabled by
// default, so nothing changes until an owner turns a pack off. This file has NO
// database or React imports so it can be used from server, client and tests.
// ─────────────────────────────────────────────────────────────────────────

export type ModuleId =
  | "core"
  | "inbox"
  | "support"
  | "marketing"
  | "automation"
  | "automotive"
  | "commerce"
  | "portal";

export type AppModule = {
  id: ModuleId;
  label: string;
  description: string;
  /** Core is mandatory — it can never be disabled. */
  mandatory?: boolean;
  /** Route prefixes this module owns. Longest-prefix match wins in moduleForPath. */
  routePrefixes: string[];
};

export const MODULE_REGISTRY: AppModule[] = [
  {
    id: "core",
    label: "CRM core",
    description: "Contacts, leads, pipeline, quotes, documents, reporting — always on.",
    mandatory: true,
    routePrefixes: [
      "/", "/contacts", "/leads", "/calendar", "/activities", "/quotes",
      "/documents", "/signatures", "/signing-workflows", "/duplicates",
      "/reports", "/targets", "/forecast", "/search", "/audit", "/trash",
      "/settings", "/help", "/library", "/document-studio", "/health",
    ],
  },
  {
    id: "inbox",
    label: "Social inbox",
    description: "Shared WhatsApp / Messenger / Instagram inbox and the Messages app.",
    routePrefixes: ["/inbox", "/messages"],
  },
  {
    id: "support",
    label: "Help desk",
    description: "Customer cases / ticketing.",
    routePrefixes: ["/cases"],
  },
  {
    id: "marketing",
    label: "Marketing",
    description: "Campaigns, surveys, referrals, journeys and lifecycle automations.",
    routePrefixes: ["/campaigns", "/surveys", "/referrals", "/journeys", "/automations"],
  },
  {
    id: "automation",
    label: "Automation & AI",
    description: "Chatbot, flow builder and competitor intelligence.",
    routePrefixes: ["/chatbot", "/bot-builder", "/competitors"],
  },
  {
    id: "automotive",
    label: "Automotive / Workshop",
    description: "Vehicles, fleets, job cards, warranty, service and deliveries.",
    routePrefixes: [
      "/vehicles", "/fleets", "/jobcards", "/warranty",
      "/service-due", "/workshop-calendar", "/parts", "/deliveries",
    ],
  },
  {
    id: "commerce",
    label: "Stock & inventory",
    description: "Stock units, products and purchase orders.",
    routePrefixes: ["/stock", "/products"],
  },
  {
    id: "portal",
    label: "Customer portal",
    description: "Customer-facing self-service portal: documents, profile and support.",
    routePrefixes: ["/portal"],
  },
];

export const ALL_MODULE_IDS: ModuleId[] = MODULE_REGISTRY.map((m) => m.id);

/** Modules an owner may toggle (everything except mandatory core). */
export const OPTIONAL_MODULE_IDS: ModuleId[] = MODULE_REGISTRY.filter((m) => !m.mandatory).map((m) => m.id);

export const MANDATORY_MODULE_IDS: ModuleId[] = MODULE_REGISTRY.filter((m) => m.mandatory).map((m) => m.id);

const MODULE_BY_ID = new Map(MODULE_REGISTRY.map((m) => [m.id, m]));
export function getModule(id: ModuleId): AppModule | undefined {
  return MODULE_BY_ID.get(id);
}

/**
 * Which module owns a given path — by longest matching route prefix. Anything
 * unmapped belongs to core (so a new route is never accidentally hidden).
 */
export function moduleForPath(pathname: string): ModuleId {
  let best: { id: ModuleId; len: number } = { id: "core", len: -1 };
  for (const m of MODULE_REGISTRY) {
    for (const prefix of m.routePrefixes) {
      if (prefix === "/") continue; // root only matches exactly, handled below
      if ((pathname === prefix || pathname.startsWith(prefix + "/")) && prefix.length > best.len) {
        best = { id: m.id, len: prefix.length };
      }
    }
  }
  return best.id;
}

/** True when the module owning `pathname` is in the enabled set (core always true). */
export function isPathEnabled(pathname: string, enabled: ReadonlySet<string>): boolean {
  const id = moduleForPath(pathname);
  if (MANDATORY_MODULE_IDS.includes(id as ModuleId)) return true;
  return enabled.has(id);
}
