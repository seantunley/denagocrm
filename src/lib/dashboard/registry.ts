/**
 * The dashboard card CATALOGUE — the declarative half.
 *
 * Every card the home screen can show is described here once: its id, its title,
 * the permission that grants it, the module pack that owns it (if any), and how
 * wide it sits in the grid. Adding a card later means adding an entry here and a
 * loader/renderer in ./cards.tsx — never touching the page.
 *
 * WHY THIS FILE IS PURE. No Prisma, no `server-only`, no env, no JSX. Two
 * reasons, and both matter:
 *
 *  1. The visibility rules below are the thing most worth testing, and a module
 *     that reaches `server-only` or constructs a PrismaClient cannot be imported
 *     by `node --test`. Keeping the catalogue and the filter pure means the
 *     "a user never sees a card they lack the permission for" guarantee is
 *     provable without a database.
 *  2. Both the RENDER path and the ADD-CARD PICKER filter through the same
 *     `visibleCards()` here. A dashboard is where aggregate data leaks quietly,
 *     and the classic way it happens is a picker that offers what the renderer
 *     would refuse — the existence and title of a card is itself a disclosure.
 *     One function, two call sites, so they cannot drift.
 *
 * The loader/renderer half lives in ./cards.tsx; `tests/dashboardCards.test.ts`
 * fails the build if the two halves ever disagree about which ids exist.
 */
import type { PermissionKey } from "@/lib/permissions";
import type { ModuleId } from "@/lib/modules/registry";
import type { JourneyConditionGroup } from "@/lib/journeyTypes";

/**
 * CONDITIONAL CARDS, AND WHY THEY REUSE THE JOURNEY ENGINE'S EVALUATOR.
 *
 * Some cards should stay quiet until there is something to see: the signing tile
 * only when quotes are actually out, the system-alert tile only when something
 * is unhealthy. That needs a condition language, and this codebase already has
 * exactly one — `evaluateConditions` in src/lib/journeyTypes.ts, with and/or,
 * nesting, and a typed operator set over a context object.
 *
 * It is reused here VERBATIM, including the `JourneyConditionGroup` type. The
 * shape of the problem is identical: evaluate a boolean expression against a
 * bag of values.
 *
 * What is deliberately NOT reused is `parseConditionGroup` and CONDITION_FIELDS.
 * Those exist to validate conditions authored by a USER in the journey builder,
 * and they enforce a closed allow-list of journey record fields — `lead.source`,
 * `contact.province`, `repeat.index`. Dashboard conditions test something else
 * entirely: how many rows a card's own loader returned. Forcing them through
 * that parser would mean adding dashboard-only names to CONDITION_FIELDS, where
 * they would appear in the journey builder's field picker meaning nothing, and
 * journey fields would appear here meaning nothing — the two would each carry
 * the other's vocabulary.
 *
 * The parser is also solving a problem this does not have. Card conditions are
 * written in TypeScript in this file, not submitted as JSON by a user, so they
 * are checked by the compiler and there is no untrusted input to validate. So:
 * the evaluator is shared, the builder-input validator is not.
 */

/**
 * "Show this card only when it has something in it."
 *
 * The common case, expressed in the shared condition language rather than as a
 * separate boolean flag, so there is one mechanism to understand instead of two.
 * `count` is the signal every list card's loader publishes.
 */
export const WHEN_NOT_EMPTY: JourneyConditionGroup = {
  logic: "and",
  conditions: [{ field: "vars.count", operator: "greater_than", value: 0 }],
};

/**
 * Every card id, in the order they appear on a brand-new user's dashboard.
 * The literal tuple is what gives us a closed `DashboardCardId` union, so a typo
 * in a default layout or a renderer key is a compile error rather than a card
 * that silently never renders.
 */
export const DASHBOARD_CARD_IDS = [
  "system-alerts",
  "sales-stats",
  "new-leads",
  "pipeline-snapshot",
  "month-targets",
  "sales-agenda",
  "out-for-signature",
  "needs-attention",
  "latest-activity",
  "service-stats",
  "service-agenda",
  "service-due",
] as const;

export type DashboardCardId = (typeof DASHBOARD_CARD_IDS)[number];

/** How many of the 3 grid columns a card occupies at desktop width. */
export type CardSpan = 1 | 2 | 3;

export type DashboardCardMeta = {
  id: DashboardCardId;
  /** Shown as the card's heading and as its label in the add-card picker. */
  title: string;
  /** One line explaining the card, for the picker only. */
  description: string;
  /**
   * ANY of these permissions grants the card — the same `hasAnyPermission`
   * shape the pages these cards summarise already use, so a card is reachable
   * exactly when the screen behind it is.
   *
   * A card whose body mixes two record types (see `needs-attention`, which pairs
   * leads with quotes) lists the union HERE, and its loader gates each half
   * independently. The union alone would let a leads-only user read quote
   * numbers off the dashboard.
   */
  permissions: readonly PermissionKey[];
  /**
   * The module pack that owns this card. When the pack is off for the tenant the
   * card does not exist: not rendered, not offered in the picker, not loaded.
   * Module state is a TENANT entitlement; `permissions` is WHO — both apply.
   */
  module?: ModuleId;
  span: CardSpan;
  /**
   * Optional visibility test, evaluated AFTER the card has loaded, against the
   * signals its loader publishes (see DASHBOARD_CARD_IMPLS). Absent means the
   * card always shows once permissions allow it — `evaluateConditions(null, …)`
   * returns true, so absence and "no clauses" agree.
   *
   * ORDER MATTERS AND IS NOT NEGOTIABLE: permission and module filtering happen
   * FIRST, and only a card the viewer is already entitled to ever gets loaded or
   * evaluated. A condition must never be the thing that decides whether a query
   * runs, or the query itself becomes the disclosure.
   *
   * COST: a condition is NOT a way to make a card free. For every card here the
   * signal is derived from the loaded rows, so the query runs and then the
   * result is thrown away. Conditional cards buy a quieter screen, not a cheaper
   * one.
   */
  condition?: JourneyConditionGroup;
};

/**
 * The catalogue. Order here is the default dashboard's order (see
 * DEFAULT_LAYOUT), which reproduces the sales-then-service grouping the fixed
 * dashboard used to get from its two tabs.
 */
export const DASHBOARD_CARDS: readonly DashboardCardMeta[] = [
  {
    id: "system-alerts",
    title: "System alerts",
    description: "Warns when the AI assistant or a security check is failing. Quiet otherwise.",
    // No permission key: everyone sees the AI-assistant warning, exactly as the
    // fixed dashboard did. The security-runbook half is owner-only and the
    // loader enforces that, so this card's contents differ by role even though
    // its existence does not.
    permissions: [],
    span: 3,
    condition: WHEN_NOT_EMPTY,
  },
  {
    id: "sales-stats",
    title: "Sales stats",
    description: "New leads, won value, open leads and deliveries this month.",
    permissions: ["leads.view_all", "leads.view_owned", "quotes.view_all", "quotes.view_owned"],
    span: 3,
  },
  {
    id: "new-leads",
    title: "Brand-new",
    description: "Leads that have come in and nobody has opened yet.",
    permissions: ["leads.view_all", "leads.view_owned"],
    span: 1,
  },
  {
    id: "pipeline-snapshot",
    title: "Pipeline snapshot",
    description: "Open leads by stage, with the total value in play.",
    permissions: ["leads.view_all", "leads.view_owned"],
    span: 2,
  },
  {
    id: "month-targets",
    title: "Month targets",
    description: "Progress rings against this month's targets.",
    permissions: ["leads.view_all", "leads.view_owned"],
    span: 1,
  },
  {
    id: "sales-agenda",
    title: "Agenda",
    description: "Your team's planned activities for today and tomorrow.",
    permissions: ["activities.view", "activities.manage"],
    span: 2,
  },
  {
    id: "out-for-signature",
    title: "Out for signature",
    description: "Quotes sent for signature and who they are waiting on.",
    permissions: ["signing.view", "signing.manage"],
    span: 1,
    // Hidden when nothing is out for signature. This restores the fixed
    // dashboard's behaviour exactly — it rendered this tile inside a
    // `signingRows.length > 0 &&` guard — now expressed as a declared condition
    // rather than an `&&` buried in the page.
    condition: WHEN_NOT_EMPTY,
  },
  {
    id: "needs-attention",
    title: "Needs attention",
    description: "Open leads with no next step, and quotes left unsigned.",
    permissions: ["leads.view_all", "leads.view_owned", "quotes.view_all", "quotes.view_owned"],
    span: 2,
  },
  {
    id: "latest-activity",
    title: "Latest activity",
    description: "New leads, logged conversations and quote events, newest first.",
    // The union of the three strands this feed braids together. Holding any one
    // of them earns the card; the loader then includes only the strands the
    // viewer actually holds, so an audit-only reader gets the quote/signing
    // events and none of the lead names.
    permissions: [
      "leads.view_all",
      "leads.view_owned",
      "contacts.view_all",
      "contacts.view_owned",
      "audit.view",
    ],
    span: 3,
  },
  {
    id: "service-stats",
    title: "Service stats",
    description: "Open job cards, services completed, vehicles due and fleet size.",
    permissions: ["jobcards.view_all", "jobcards.view_owned", "vehicles.view_all", "vehicles.view_owned"],
    module: "automotive",
    span: 3,
  },
  {
    id: "service-agenda",
    title: "Workshop agenda",
    description: "Workshop activities booked for today and tomorrow.",
    permissions: ["activities.view", "activities.manage"],
    module: "automotive",
    span: 2,
  },
  {
    id: "service-due",
    title: "Vehicles due for service",
    description: "Vehicles overdue or coming up for a service.",
    permissions: ["vehicles.view_all", "vehicles.view_owned"],
    module: "automotive",
    span: 1,
  },
];

/**
 * A new user's dashboard, which is deliberately the FULL catalogue in catalogue
 * order — the same content, in the same grouping, the fixed dashboard showed.
 * Permission and module filtering then removes what this particular user may not
 * see, so "the default" is one list rather than a per-role matrix that could
 * drift out of step with the permission checks.
 *
 * This is also what "Reset to default" restores.
 */
export const DEFAULT_LAYOUT: readonly DashboardCardId[] = DASHBOARD_CARD_IDS;

/**
 * Hard ceiling on cards in a saved layout.
 *
 * A dashboard is N queries fired at once and it is the first screen every user
 * sees, so the query count has to be bounded by something the user cannot raise.
 * The cap is enforced on the WRITE path (the action refuses a longer list) and
 * again on the READ path (`normaliseLayout` truncates), because a row could
 * predate a future cap reduction. Today the catalogue is smaller than the cap,
 * so the cap only ever binds after the catalogue grows.
 */
export const MAX_CARDS = 24;

const CARD_BY_ID = new Map<string, DashboardCardMeta>(DASHBOARD_CARDS.map((c) => [c.id, c]));

export function isDashboardCardId(value: unknown): value is DashboardCardId {
  return typeof value === "string" && CARD_BY_ID.has(value);
}

export function cardById(id: string): DashboardCardMeta | undefined {
  return CARD_BY_ID.get(id);
}

/**
 * What the current user is allowed to see, as plain sets.
 *
 * `permissions` is the caller's USABLE permission list — for an owner that is
 * the whole catalogue, and for an uninitialised/unavailable RBAC state it is
 * empty. Resolving it to a set once per request and passing it down means every
 * card answers from the same snapshot and costs one RBAC read, not one per card.
 */
export type DashboardAccess = {
  permissions: ReadonlySet<string>;
  modules: ReadonlySet<string>;
};

/**
 * May this user see this card AT ALL?
 *
 * Two independent gates, both of which must pass:
 *   - MODULE: a card belonging to a pack the tenant has switched off does not
 *     exist for anyone, owner included. That is a tenant entitlement, not a
 *     privilege, so no role overrides it.
 *   - PERMISSION: any one of the card's declared keys. A card with an empty
 *     permission list is visible to every signed-in user; none exist today, and
 *     the empty case is spelled out rather than left to `.some()` returning
 *     false so that a future card cannot become invisible by accident.
 */
export function canSeeCard(meta: DashboardCardMeta, access: DashboardAccess): boolean {
  if (meta.module && !access.modules.has(meta.module)) return false;
  if (meta.permissions.length === 0) return true;
  return meta.permissions.some((key) => access.permissions.has(key));
}

/**
 * Turn whatever is stored for this user into a safe, ordered card list.
 *
 * This is the function that has to survive a layout saved by an OLDER or NEWER
 * release of the app, because the home page is the one screen a user cannot
 * route around. Everything it does not understand it drops:
 *
 *   - a value that is not an array at all (hand-edited JSON, a botched write)
 *     → fall back to the default layout rather than render an empty page;
 *   - entries that are not strings → dropped;
 *   - ids no longer in the catalogue (a card removed in a later release) →
 *     dropped, which is the whole point: an unknown id must degrade to "one
 *     fewer card", never to a crash on the home screen;
 *   - duplicates → first occurrence wins, so a double-save cannot make a card
 *     render twice and double its queries;
 *   - anything past MAX_CARDS → truncated.
 *
 * An EMPTY array is preserved as empty. A user who removes every card meant to,
 * and silently restoring the default would make the remove button look broken.
 * Only a structurally invalid value falls back to the default.
 *
 * Note this does NOT filter by permission — that is `visibleCards()`. Keeping
 * the two apart matters: the stored layout is the user's preference and may
 * legitimately mention a card they cannot currently see (a permission revoked
 * and later restored should bring the card back, not require re-adding it).
 */
export function normaliseLayout(stored: unknown): DashboardCardId[] {
  if (!Array.isArray(stored)) return [...DEFAULT_LAYOUT];
  const seen = new Set<DashboardCardId>();
  for (const entry of stored) {
    if (!isDashboardCardId(entry)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (seen.size >= MAX_CARDS) break;
  }
  return [...seen];
}

/**
 * The cards to actually render, in the user's order: their layout, minus
 * anything their permissions or the tenant's modules do not admit.
 */
export function visibleCards(
  layout: readonly DashboardCardId[],
  access: DashboardAccess,
): DashboardCardMeta[] {
  const out: DashboardCardMeta[] = [];
  for (const id of layout) {
    const meta = CARD_BY_ID.get(id);
    if (meta && canSeeCard(meta, access)) out.push(meta);
  }
  return out;
}

/**
 * The add-card picker's contents: everything this user may see that is not
 * already on their dashboard.
 *
 * Filtered through the SAME `canSeeCard` the renderer uses. A picker built from
 * the raw catalogue would tell a user without `signing.view` that an "Out for
 * signature" card exists and how it is described — a small leak, but a real one,
 * and exactly the kind a dashboard invites.
 */
export function addableCards(
  layout: readonly DashboardCardId[],
  access: DashboardAccess,
): DashboardCardMeta[] {
  const present = new Set(layout);
  return DASHBOARD_CARDS.filter((meta) => !present.has(meta.id) && canSeeCard(meta, access));
}

/**
 * Does this card come and go on its own?
 *
 * The picker uses this to badge conditional cards. Without the badge a
 * conditional card is undiscoverable in the worst way: a user adds "Out for
 * signature", nothing appears because nothing is out for signature, and the
 * feature looks broken. The badge is shown for cards the user is ALREADY
 * entitled to — it says nothing about cards they cannot see, which stay absent
 * from the picker entirely.
 */
export function isConditional(meta: DashboardCardMeta): boolean {
  return Boolean(meta.condition && meta.condition.conditions.length > 0);
}
