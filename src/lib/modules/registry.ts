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
  | "portal"
  | "multicurrency"
  | "suppliers"
  | "signatures"
  | "finance"
  | "warranty"
  | "work";

export type AppModule = {
  id: ModuleId;
  label: string;
  description: string;
  mandatory?: boolean;
  /** Another module this one is built on: with that one off, this one is off too (entitlement.ts). */
  requires?: ModuleId;
  routePrefixes: string[];
  /** Permissions that belong to this module: with it off nobody holds them, not even the owner (permissions.ts). */
  permissionPrefixes?: string[];
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
      "/messages/start", "/today", "/notifications", "/birthdays", "/data-quality",
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
    description: "Chatbot, flow builder, competitor intelligence and Ask the CRM.",
    routePrefixes: ["/chatbot", "/bot-builder", "/competitors", "/assistant"],
  },
  {
    id: "automotive",
    label: "Automotive / Workshop",
    description: "Vehicles, fleets, test drives, job cards, service and deliveries.",
    routePrefixes: [
      "/vehicles", "/fleets", "/test-drives", "/jobcards",
      "/service-due", "/workshop-calendar", "/parts", "/deliveries", "/invoices",
    ],
  },
  {
    id: "warranty",
    label: "Warranty",
    description: "Warranty cover on each vehicle, claims, recalls and warranty certificates. Off: everything warranty is hidden from the CRM, the portal and the assistant; the records are kept.",
    // Sean, 2026-11-21: "Warranty must be a completely separate module". Built on vehicles.
    requires: "automotive",
    routePrefixes: ["/warranty"],
    permissionPrefixes: ["warranty."],
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
  {
    id: "multicurrency",
    label: "Multi-currency",
    description: "Quote, invoice and take payment in each customer's currency; totals are shown per currency.",
    // No pages of its own: it adds a currency to leads and quotes wherever they appear.
    routePrefixes: [],
  },
  {
    id: "suppliers",
    label: "Suppliers",
    description: "Suppliers on deals and purchase orders: each deal's file asks every supplier for its quote, invoice and proof of payment.",
    // Settings → Suppliers only. The rest of it lives inside the deal file, documents and purchase orders.
    routePrefixes: ["/settings/vendors"],
  },
  {
    id: "signatures",
    label: "Email signatures",
    description: "Everyone's email signature in one place: the workspace design, each person's own signature and the banners under it. Off: emails keep the automatic signature, with no banners.",
    // Sean, 2026-11-20: "I think it needs its own module now." Its page, and the banners' settings page.
    routePrefixes: ["/email-signatures", "/settings/signature-banners"],
  },
  {
    id: "finance",
    label: "Finance",
    description: "Deals paid through an outside finance house: where each stands, chased when it stalls, and delivery held until it's approved.",
    // The finance house is a supplier of type Finance, added to the deal (Sean, 2026-11-16).
    requires: "suppliers",
    // The Finance list. The rest lives on the deal: its Finance tab, the delivery hold, the chaser, DAX.
    routePrefixes: ["/finance"],
  },
  {
    id: "work",
    label: "My Work",
    description: "One list per person of everything waiting on them — deals to contact, tasks, deliveries, job cards, cases and approvals — by when it is due.",
    // Sean, 2026-11-24: every workspace eventually, Denago only while it is tested.
    routePrefixes: ["/work"],
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

const MODULE_BY_ID = new Map(MODULE_REGISTRY.map((mod) => [mod.id, mod]));

export function getModule(id: ModuleId): AppModule | undefined {
  return MODULE_BY_ID.get(id);
}

/** The switchable module a permission belongs to, or null (most permissions belong to none). */
export function moduleForPermission(permission: string): ModuleId | null {
  for (const mod of MODULE_REGISTRY) {
    if (mod.permissionPrefixes?.some((prefix) => permission.startsWith(prefix))) return mod.id;
  }
  return null;
}

export function moduleForPath(pathname: string): ModuleId {
  let best: { id: ModuleId; len: number } = { id: "core", len: -1 };
  for (const mod of MODULE_REGISTRY) {
    for (const prefix of mod.routePrefixes) {
      if (prefix === "/") continue;
      if ((pathname === prefix || pathname.startsWith(prefix + "/")) && prefix.length > best.len) {
        best = { id: mod.id, len: prefix.length };
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
