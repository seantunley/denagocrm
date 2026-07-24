// ─────────────────────────────────────────────────────────────────────────
// Module registry — Path A, Phase 1.
//
// The single declarative source of truth for the app's feature "packs". Turning
// DenagoCRM into a configurable product means the CRM core is always present and
// everything else is an optional pack a tenant can switch off.
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
  mandatory?: boolean;
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
      "/messages/start",
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
    routePrefixes: ["/cases", "/messages/cases"],
  },
  {
    id: "marketing",
    label: "Marketing",
    description: "Campaigns, surveys, referrals, journeys and lifecycle automations.",
    routePrefixes: ["/marketing", "/campaigns", "/surveys", "/referrals", "/journeys", "/automations"],
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

export const AUTOMOTIVE_DELIVERY_TAGS = [
  "delivery-note",
  "delivery-photo",
  "delivery-signature",
] as const;

export function isAutomotiveOwnedDocument(doc: {
  vehicleId?: string | null;
  jobCardId?: string | null;
  tag?: string | null;
}): boolean {
  if (doc.vehicleId != null || doc.jobCardId != null) return true;
  return doc.tag != null && (AUTOMOTIVE_DELIVERY_TAGS as readonly string[]).includes(doc.tag);
}

export function automotiveDocumentWhere() {
  return {
    OR: [
      { vehicleId: { not: null } },
      { jobCardId: { not: null } },
      { tag: { in: [...AUTOMOTIVE_DELIVERY_TAGS] } },
    ],
  };
}

export function nonAutomotiveDocumentWhere() {
  return {
    vehicleId: null,
    jobCardId: null,
    OR: [{ tag: null }, { tag: { notIn: [...AUTOMOTIVE_DELIVERY_TAGS] } }],
  };
}

export const ALL_MODULE_IDS: ModuleId[] = MODULE_REGISTRY.map((module) => module.id);
export const OPTIONAL_MODULE_IDS: ModuleId[] = MODULE_REGISTRY.filter((module) => !module.mandatory).map((module) => module.id);
export const MANDATORY_MODULE_IDS: ModuleId[] = MODULE_REGISTRY.filter((module) => module.mandatory).map((module) => module.id);

const MODULE_BY_ID = new Map(MODULE_REGISTRY.map((module) => [module.id, module]));

export function getModule(id: ModuleId): AppModule | undefined {
  return MODULE_BY_ID.get(id);
}

export function moduleForPath(pathname: string): ModuleId {
  let best: { id: ModuleId; len: number } = { id: "core", len: -1 };
  for (const module of MODULE_REGISTRY) {
    for (const prefix of module.routePrefixes) {
      if (prefix === "/") continue;
      if ((pathname === prefix || pathname.startsWith(prefix + "/")) && prefix.length > best.len) {
        best = { id: module.id, len: prefix.length };
      }
    }
  }
  return best.id;
}

export function isPathEnabled(pathname: string, enabled: ReadonlySet<string>): boolean {
  const id = moduleForPath(pathname);
  if (MANDATORY_MODULE_IDS.includes(id as ModuleId)) return true;
  return enabled.has(id);
}
