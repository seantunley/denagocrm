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
      // The Messages-PWA landing route redirects to Chats/Help desk by
      // permission, so it must be reachable whether Inbox or Support is the
      // enabled pack — classify it core. Longest-prefix match keeps it here
      // ("/messages/start" > "/messages") while plain "/messages" stays inbox.
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
    // "/messages/cases" is the Messages-PWA help-desk page; it must belong to
    // support (not inbox) so longest-prefix match resolves it here and the
    // messages layout's route guard blocks it when the support pack is off,
    // while plain "/messages" stays inbox.
    routePrefixes: ["/cases", "/messages/cases"],
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
    description: "Vehicles, fleets, test drives, job cards, warranty, service and deliveries.",
    routePrefixes: [
      "/vehicles", "/fleets", "/test-drives", "/jobcards", "/warranty",
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

/**
 * Document `tag` values that are automotive-owned delivery paperwork. These docs
 * are linked to a contact/quote (not a vehicle), so a plain vehicleId check misses
 * them — when the automotive pack is off they must still be treated as automotive
 * (hidden and not downloadable). Written by src/app/actions/fulfilment.ts.
 */
export const AUTOMOTIVE_DELIVERY_TAGS = [
  "delivery-note",
  "delivery-photo",
  "delivery-signature",
] as const;

/**
 * True when a document belongs to the automotive pack — either linked to a
 * vehicle/job card, or tagged as delivery paperwork (which is filed against a
 * contact/quote, so the id checks alone miss it). When automotive is off these
 * docs must be hidden and non-downloadable. Pure + DB-free so the staff repo
 * (/documents), the staff file API (/api/files) and the portal all share one
 * definition. Plain contact/quote docs (null id + null/other tag) are core.
 */
export function isAutomotiveOwnedDocument(doc: {
  vehicleId?: string | null;
  jobCardId?: string | null;
  tag?: string | null;
}): boolean {
  if (doc.vehicleId != null || doc.jobCardId != null) return true;
  return doc.tag != null && (AUTOMOTIVE_DELIVERY_TAGS as readonly string[]).includes(doc.tag);
}

/**
 * Prisma `where` fragments that mirror isAutomotiveOwnedDocument() so the
 * in-memory predicate and the database filter cannot drift. Returned as plain
 * object literals (no Prisma import) so this file stays server/client/test-safe.
 *
 * nonAutomotiveDocumentWhere() is deliberately NULL-safe: `tag` is nullable, and
 * `NOT { tag: { in: […] } }` evaluates to UNKNOWN (not TRUE) for a NULL tag in
 * SQL three-valued logic, which would wrongly drop untagged CORE documents. So
 * the non-automotive filter is written positively — vehicleId/jobCardId are NULL
 * AND the tag is either NULL or not one of the delivery tags.
 */
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
