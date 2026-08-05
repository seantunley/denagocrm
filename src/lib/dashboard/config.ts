/**
 * The dashboard config model: dashboard → views → sections → cards.
 *
 * ── WHY FOUR LEVELS ─────────────────────────────────────────────────────────
 *
 * The first version of this had one: a flat, ordered list of card ids. That is
 * enough to arrange twelve fixed cards and nothing more, and it runs out the
 * moment anyone wants a second screen, a heading between two groups, or a card
 * whose width they choose. Each level below earns its place by being the only
 * one that can express something:
 *
 *   DASHBOARD  Several, each with its own name and its own tab in the nav. A
 *              workshop foreman and a sales manager want different screens, not
 *              one screen with everything on it.
 *   VIEW       Tabs within a dashboard. The alternative is scrolling, and a
 *              screen you have to scroll is a screen nobody reads past the fold.
 *   SECTION    A titled group that owns a column span. This is what lets "Today"
 *              and "This month" sit side by side as blocks rather than as twelve
 *              cards the grid happens to have laid out that way.
 *   CARD       The leaf, or a container of more cards.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * There is no separate "conditional card" wrapper. Every level carries the same
 * `visibility: Condition[]`, so hiding a card is a property OF the card rather
 * than a box drawn around it. Having both would be two ways to express one idea,
 * differing only in where the condition is written down.
 *
 * There is no free-form layout — no x/y/width/height. A saved absolute layout is
 * wrong on the next screen size, and repairing it is the kind of work that never
 * ends. Cards declare a column span and the grid places them.
 *
 * ── EVERY FUNCTION HERE ASSUMES ITS INPUT IS HOSTILE ────────────────────────
 *
 * A config is JSON a user saved, possibly under an older release, possibly by
 * hand through the raw editor. `parseConfig` is the only way in and it drops
 * what it does not understand rather than throwing, because the home screen is
 * the one page a user cannot route around: an unparseable config must degrade to
 * a default dashboard, never to an error page.
 *
 * PURE. No Prisma, no `server-only`, no JSX — same discipline as registry.ts and
 * sources.ts, so the parsing and normalisation rules are testable directly.
 */
import { z } from "zod";
import {
  MAX_CONDITIONS,
  MAX_CONDITION_DEPTH,
  BREAKPOINTS,
  type Condition,
} from "./conditions";
import { DASHBOARD_CARD_IDS } from "./registry";
import { PERIODS, SOURCES } from "./sources";

/* ── caps ─────────────────────────────────────────────────────────── */

/**
 * Bounds on a config, all enforced on the way IN (the action refuses) and again
 * on the way OUT (the parser truncates).
 *
 * Both ends, because a row can predate a cap being lowered, and because the
 * write path and the read path have different jobs: refusing tells the user
 * their config is too big, truncating keeps an already-stored oversized config
 * from taking the page down. Neither alone is enough.
 *
 * The numbers are chosen against what a dashboard COSTS rather than what looks
 * tidy. Every query card is at least one database round trip on the first screen
 * every user sees, so the ceiling that matters is cards-per-view.
 */
export const LIMITS = {
  dashboardsPerUser: 12,
  viewsPerDashboard: 12,
  sectionsPerView: 12,
  /** Across every section and every nesting level of one view. */
  cardsPerView: 40,
  cardsPerSection: 24,
  /** How deep container cards may nest. See MAX_CARD_DEPTH's note. */
  cardDepth: 3,
  filtersPerCard: 8,
  columnsPerCard: 6,
  listRows: 50,
  titleLength: 80,
  markdownLength: 4000,
} as const;

/**
 * Container nesting depth.
 *
 * Three is not a taste judgement — a stack inside a grid inside a section is
 * already at the edge of what anyone can reason about, and the recursion in
 * `parseCard` walks untrusted JSON, so the cap is what stands between a
 * hand-edited config and a stack overflow on the home page.
 */
export const MAX_CARD_DEPTH = LIMITS.cardDepth;

/* ── conditions ───────────────────────────────────────────────────── */

const OPERATOR = z.enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "greater_than",
  "greater_or_equal",
  "less_than",
  "less_or_equal",
  "in",
  "is_empty",
  "is_not_empty",
]);

/**
 * The condition schema, built to a fixed depth rather than with `z.lazy`.
 *
 * `z.lazy` would express the recursion in one line and would also happily
 * validate a config nested four hundred deep, which is the failure this needs to
 * prevent, not permit. Unrolling to MAX_CONDITION_DEPTH makes the cap part of
 * the type rather than a check bolted on afterwards — a too-deep group fails to
 * parse and is dropped, exactly like any other malformed entry.
 */
function conditionSchema(depth: number): z.ZodType<Condition> {
  const leaf = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("data"),
      field: z.string().min(1).max(40),
      operator: OPERATOR,
      value: z.unknown().optional(),
    }),
    z.object({ kind: z.literal("user"), users: z.array(z.string().min(1)).min(1).max(50) }),
    z.object({ kind: z.literal("role"), roles: z.array(z.string().min(1)).min(1).max(20) }),
    z.object({
      kind: z.literal("permission"),
      permissions: z.array(z.string().min(1)).min(1).max(20),
    }),
    z.object({ kind: z.literal("module"), modules: z.array(z.string().min(1)).min(1).max(20) }),
    z.object({
      kind: z.literal("time"),
      after: z.string().optional(),
      before: z.string().optional(),
      weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    }),
    z.object({
      kind: z.literal("screen"),
      breakpoints: z.array(z.enum(BREAKPOINTS)).min(1).max(3),
    }),
  ]);

  if (depth <= 1) return leaf as unknown as z.ZodType<Condition>;
  const inner = conditionSchema(depth - 1);
  return z.union([
    leaf,
    z.object({ kind: z.literal("and"), conditions: z.array(inner).min(1).max(MAX_CONDITIONS) }),
    z.object({ kind: z.literal("or"), conditions: z.array(inner).min(1).max(MAX_CONDITIONS) }),
    z.object({ kind: z.literal("not"), condition: inner }),
  ]) as unknown as z.ZodType<Condition>;
}

const CONDITIONS = z.array(conditionSchema(MAX_CONDITION_DEPTH)).max(MAX_CONDITIONS).optional();

/* ── queries ──────────────────────────────────────────────────────── */

const SOURCE_IDS = SOURCES.map((s) => s.id) as [string, ...string[]];
const PERIOD_IDS = PERIODS.map((p) => p.id) as [string, ...string[]];

export const FILTER = z.object({
  field: z.string().min(1).max(40),
  operator: OPERATOR,
  value: z.unknown().optional(),
});
export type QueryFilter = z.infer<typeof FILTER>;

/**
 * `scope` is the "mine or everyone's" switch, and `mine` is a NARROWING only.
 *
 * Choosing `team` does not widen anything: the source's own row scope still
 * applies, so a rep who may only see their own leads gets their own leads under
 * either setting. The switch exists so a manager who CAN see the whole team can
 * still build a card about their own pipeline — it can subtract, never add.
 */
export const QUERY = z.object({
  source: z.enum(SOURCE_IDS),
  filters: z.array(FILTER).max(LIMITS.filtersPerCard).default([]),
  scope: z.enum(["mine", "team"]).default("team"),
  period: z.enum(PERIOD_IDS).default("all"),
  /** Which date field the period applies to. Defaults to the source's own. */
  periodField: z.string().max(40).optional(),
  sort: z
    .object({ field: z.string().min(1).max(40), dir: z.enum(["asc", "desc"]) })
    .optional(),
  limit: z.number().int().min(1).max(LIMITS.listRows).default(8),
});
export type CardQuery = z.infer<typeof QUERY>;

export const METRIC = z.object({
  fn: z.enum(["count", "sum", "avg", "min", "max"]).default("count"),
  /** Required for everything except `count`; ignored for it. */
  field: z.string().max(40).optional(),
});
export type CardMetric = z.infer<typeof METRIC>;

/* ── cards ────────────────────────────────────────────────────────── */

export const CARD_TYPES = [
  "builtin",
  "stat",
  "list",
  "chart",
  "gauge",
  "markdown",
  "heading",
  "button",
  "grid",
  "stack",
] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Card types that hold other cards. */
export const CONTAINER_TYPES = ["grid", "stack"] as const satisfies readonly CardType[];

/** Card types that run a query, and therefore cost a round trip. */
export const QUERY_TYPES = ["stat", "list", "chart", "gauge"] as const satisfies readonly CardType[];

export function isContainer(type: CardType): boolean {
  return (CONTAINER_TYPES as readonly string[]).includes(type);
}

export function isQueryCard(type: CardType): boolean {
  return (QUERY_TYPES as readonly string[]).includes(type);
}

const SPAN = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const TITLE = z.string().max(LIMITS.titleLength).optional();

const BASE_CARD = {
  id: z.string().min(1).max(40),
  title: TITLE,
  span: SPAN.default(1),
  visibility: CONDITIONS,
  /**
   * Kept in the config but not rendered.
   *
   * The editor's alternative to deleting a card while trying something out. It
   * matters that this is not the same as removing it: a card someone spent ten
   * minutes configuring should be recoverable by a click, and "delete it and
   * rebuild it" is how people learn not to experiment.
   */
  disabled: z.boolean().optional(),
};

function cardSchema(depth: number): z.ZodType<CardConfig> {
  const leaves = [
    // The code-defined cards from registry.ts, unchanged and still first-class.
    // A user-built dashboard is not a reason to lose "Sales stats"; it is a
    // reason to be able to put it next to something of your own.
    z.object({ ...BASE_CARD, type: z.literal("builtin"), card: z.enum(DASHBOARD_CARD_IDS) }),
    z.object({
      ...BASE_CARD,
      type: z.literal("stat"),
      query: QUERY,
      metric: METRIC.default({ fn: "count" }),
      /** Show the change against the preceding period of the same length. */
      compare: z.boolean().default(false),
      href: z.string().max(200).optional(),
    }),
    z.object({
      ...BASE_CARD,
      type: z.literal("list"),
      query: QUERY,
      columns: z.array(z.string().min(1).max(40)).max(LIMITS.columnsPerCard).default([]),
    }),
    z.object({
      ...BASE_CARD,
      type: z.literal("chart"),
      query: QUERY,
      groupBy: z.string().min(1).max(40),
      metric: METRIC.default({ fn: "count" }),
      style: z.enum(["bar", "donut"]).default("bar"),
    }),
    z.object({
      ...BASE_CARD,
      type: z.literal("gauge"),
      query: QUERY,
      metric: METRIC.default({ fn: "count" }),
      target: z.number().min(1).max(1_000_000_000),
      unit: z.string().max(12).optional(),
    }),
    z.object({
      ...BASE_CARD,
      type: z.literal("markdown"),
      /*
       * Rendered as PLAIN TEXT today — paragraphs and line breaks, every
       * character a JSX text node, no `dangerouslySetInnerHTML` anywhere near
       * it.
       *
       * The app has no markdown dependency and no sanitising renderer, and the
       * honest options were to add one or to render text. A card whose content
       * is typed by one user and displayed to others is not the place to
       * introduce the first HTML-from-a-string path in the codebase, so the
       * name is aspirational and the behaviour is deliberately duller than it.
       * See renderMarkdown in components/dashboard/cards/markdown.tsx — that is
       * the single function to change if a sanitising renderer ever lands.
       */
      content: z.string().max(LIMITS.markdownLength).default(""),
    }),
    z.object({
      ...BASE_CARD,
      type: z.literal("heading"),
      /** Headings span the row by default — that is what makes them dividers. */
      span: SPAN.default(4),
    }),
    z.object({
      ...BASE_CARD,
      type: z.literal("button"),
      /**
       * An INTERNAL path only. Not a URL: a dashboard is shared by screenshot
       * and by shoulder, and a button someone can point at an external host is
       * a phishing surface inside the product's own chrome. `normaliseHref`
       * enforces the leading slash and refuses protocol-relative paths.
       */
      href: z.string().min(1).max(200),
      icon: z.string().max(40).optional(),
    }),
  ];

  if (depth <= 1) {
    // At the floor, containers are simply not offered, so a too-deep config
    // fails to parse at the container and gets dropped — the same degradation
    // as any other unrecognised card.
    return z.discriminatedUnion("type", leaves as never) as unknown as z.ZodType<CardConfig>;
  }

  const inner = cardSchema(depth - 1);
  return z.discriminatedUnion("type", [
    ...leaves,
    z.object({
      ...BASE_CARD,
      type: z.literal("grid"),
      columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2),
      cards: z.array(inner).max(LIMITS.cardsPerSection).default([]),
    }),
    z.object({
      ...BASE_CARD,
      type: z.literal("stack"),
      direction: z.enum(["vertical", "horizontal"]).default("vertical"),
      cards: z.array(inner).max(LIMITS.cardsPerSection).default([]),
    }),
  ] as never) as unknown as z.ZodType<CardConfig>;
}

/* The public card type, written out rather than inferred, so the editor and the
 * renderer can name each variant without unwrapping a zod inference. */

type CardBase = {
  id: string;
  title?: string;
  span: 1 | 2 | 3 | 4;
  visibility?: Condition[];
  disabled?: boolean;
};

export type BuiltinCard = CardBase & { type: "builtin"; card: (typeof DASHBOARD_CARD_IDS)[number] };
export type StatCard = CardBase & { type: "stat"; query: CardQuery; metric: CardMetric; compare: boolean; href?: string };
export type ListCard = CardBase & { type: "list"; query: CardQuery; columns: string[] };
export type ChartCard = CardBase & { type: "chart"; query: CardQuery; groupBy: string; metric: CardMetric; style: "bar" | "donut" };
export type GaugeCard = CardBase & { type: "gauge"; query: CardQuery; metric: CardMetric; target: number; unit?: string };
export type MarkdownCard = CardBase & { type: "markdown"; content: string };
export type HeadingCard = CardBase & { type: "heading" };
export type ButtonCard = CardBase & { type: "button"; href: string; icon?: string };
export type GridCardConfig = CardBase & { type: "grid"; columns: 2 | 3 | 4; cards: CardConfig[] };
export type StackCardConfig = CardBase & { type: "stack"; direction: "vertical" | "horizontal"; cards: CardConfig[] };

export type CardConfig =
  | BuiltinCard
  | StatCard
  | ListCard
  | ChartCard
  | GaugeCard
  | MarkdownCard
  | HeadingCard
  | ButtonCard
  | GridCardConfig
  | StackCardConfig;

/* ── sections, views, dashboards ──────────────────────────────────── */

export const SECTION = z.object({
  id: z.string().min(1).max(40),
  title: TITLE,
  columnSpan: SPAN.default(1),
  visibility: CONDITIONS,
  cards: z.array(cardSchema(MAX_CARD_DEPTH)).max(LIMITS.cardsPerSection).default([]),
});
export type SectionConfig = {
  id: string;
  title?: string;
  columnSpan: 1 | 2 | 3 | 4;
  visibility?: Condition[];
  cards: CardConfig[];
};

export const VIEW = z.object({
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(LIMITS.titleLength),
  /** A lucide icon name. Validated against the allowlist at render, not here. */
  icon: z.string().max(40).optional(),
  /** URL segment. Lower-cased and stripped by `slugify` before it is stored. */
  path: z.string().min(1).max(60),
  columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(3),
  visibility: CONDITIONS,
  sections: z.array(SECTION).max(LIMITS.sectionsPerView).default([]),
});
export type ViewConfig = {
  id: string;
  title: string;
  icon?: string;
  path: string;
  columns: 1 | 2 | 3 | 4;
  visibility?: Condition[];
  sections: SectionConfig[];
};

export const CONFIG = z.object({
  /**
   * Schema version, stamped on every write.
   *
   * Not decoration: this is what makes it possible to migrate a stored config
   * later without guessing. `parseConfig` accepts an absent version as 1 —
   * configs written before the field existed — and refuses a version from the
   * future rather than silently misreading it, which would be the worse
   * failure: a config written by a newer release, half-understood by an older
   * one, and then saved back with the parts it did not recognise dropped.
   */
  version: z.number().int().min(1).default(1),
  title: z.string().max(LIMITS.titleLength).optional(),
  views: z.array(VIEW).max(LIMITS.viewsPerDashboard).default([]),
});

export type DashboardConfig = {
  version: number;
  title?: string;
  views: ViewConfig[];
};

/** The highest version this build knows how to read. */
export const CONFIG_VERSION = 1;

/* ── parsing ──────────────────────────────────────────────────────── */

export type ParseResult =
  | { ok: true; config: DashboardConfig; dropped: string[] }
  | { ok: false; error: string };

/**
 * Strict parse, for the WRITE path.
 *
 * The editor and the raw JSON editor both go through here, and both want to be
 * told what is wrong rather than have it quietly removed — someone who has just
 * hand-edited a card wants "unknown card type 'guage'", not a config that saves
 * successfully with their card missing.
 */
export function parseConfigStrict(input: unknown): ParseResult {
  const result = CONFIG.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path?.length ? ` at ${first.path.join(".")}` : "";
    return { ok: false, error: `${first?.message ?? "Invalid dashboard"}${where}` };
  }
  if (result.data.version > CONFIG_VERSION) {
    return {
      ok: false,
      error: "This dashboard was saved by a newer version of the app.",
    };
  }
  const config = result.data as DashboardConfig;
  const problems = structuralProblems(config);
  if (problems.length > 0) return { ok: false, error: problems[0] };
  return { ok: true, config, dropped: [] };
}

/**
 * Lenient parse, for the READ path.
 *
 * Everything it cannot understand is dropped and NAMED in `dropped`, so the page
 * can tell the user "one card was removed because it no longer exists" instead
 * of leaving them to notice a gap. The distinction from the strict parse is the
 * whole degradation story: a config that fails to save is a message, a config
 * that fails to load is a broken home screen, so the read path never fails.
 */
export function parseConfig(input: unknown): { config: DashboardConfig; dropped: string[] } {
  const dropped: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { config: emptyConfig(), dropped: ["The saved dashboard could not be read."] };
  }
  const raw = input as Record<string, unknown>;
  const views: ViewConfig[] = [];
  const rawViews = Array.isArray(raw.views) ? raw.views : [];
  for (const candidate of rawViews.slice(0, LIMITS.viewsPerDashboard)) {
    const parsed = VIEW.safeParse(candidate);
    if (parsed.success) {
      views.push(parsed.data as ViewConfig);
      continue;
    }
    // A whole view failed. Try to salvage its intact cards rather than losing
    // the tab: one card written by a newer release must not cost the user the
    // eleven around it.
    const salvaged = salvageView(candidate, dropped);
    if (salvaged) views.push(salvaged);
    else dropped.push("A tab could not be read and was removed.");
  }
  const version = typeof raw.version === "number" ? raw.version : 1;
  const title = typeof raw.title === "string" ? raw.title.slice(0, LIMITS.titleLength) : undefined;
  /*
   * The version is carried through UNCHANGED, and that is the whole point.
   *
   * Clamping it to CONFIG_VERSION was the obvious thing and it was wrong in the
   * exact way this comment used to claim it was not. Picture a release that
   * writes version 2 and is then rolled back. The old build reads the config,
   * understands the parts it recognises, drops the rest — fine so far, that is
   * what a read path is for. But if it also rewrote the stamp to 1, the config
   * would then pass `parseConfigStrict` on the next save, and the user's next
   * unrelated edit would quietly persist the half-understood version as though
   * it were complete. The parts the older build never knew about would be gone
   * for good, and nobody would have been told.
   *
   * Leaving the stamp alone makes the write path refuse (it checks
   * `version > CONFIG_VERSION`), so the worst case is a dashboard that renders
   * best-effort and cannot be saved until the newer build is back — recoverable,
   * and loud about it.
   */
  if (version > CONFIG_VERSION) {
    dropped.push(
      "This dashboard was saved by a newer version of the app. It is shown as best we can read it, and cannot be saved until that version is back.",
    );
  }
  const config: DashboardConfig = { version, title, views };
  enforceCardBudget(config, dropped);
  return { config, dropped };
}

/** Rebuild one view from whatever parts of it still parse. */
function salvageView(candidate: unknown, dropped: string[]): ViewConfig | null {
  if (!candidate || typeof candidate !== "object") return null;
  const raw = candidate as Record<string, unknown>;
  if (typeof raw.title !== "string" || raw.title.length === 0) return null;
  const sections: SectionConfig[] = [];
  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
  for (const rawSection of rawSections.slice(0, LIMITS.sectionsPerView)) {
    const parsedSection = SECTION.safeParse(rawSection);
    if (parsedSection.success) {
      sections.push(parsedSection.data as SectionConfig);
      continue;
    }
    if (!rawSection || typeof rawSection !== "object") continue;
    const sectionRaw = rawSection as Record<string, unknown>;
    const cards: CardConfig[] = [];
    const cardSchemaAtTop = cardSchema(MAX_CARD_DEPTH);
    for (const rawCard of Array.isArray(sectionRaw.cards) ? sectionRaw.cards : []) {
      const parsedCard = cardSchemaAtTop.safeParse(rawCard);
      if (parsedCard.success) cards.push(parsedCard.data);
      else dropped.push(describeDroppedCard(rawCard));
    }
    sections.push({
      id: typeof sectionRaw.id === "string" ? sectionRaw.id : `section-${sections.length}`,
      title: typeof sectionRaw.title === "string" ? sectionRaw.title : undefined,
      // Salvaged INDEPENDENTLY of the cards, and this is not tidiness.
      //
      // A section fails to parse most often because ONE card inside it is
      // malformed. Rebuilding it with no `visibility` would take a section
      // somebody had deliberately hidden — behind a role, a permission, a time
      // of day — and make it unconditionally visible, triggered by a completely
      // unrelated card. A degradation path is allowed to show less than was
      // asked for; it must never show more.
      visibility: salvageVisibility(sectionRaw.visibility),
      columnSpan: salvageSpan(sectionRaw.columnSpan),
      cards,
    });
  }
  return {
    id: typeof raw.id === "string" ? raw.id : `view-${Math.abs(hashString(raw.title))}`,
    title: raw.title.slice(0, LIMITS.titleLength),
    icon: typeof raw.icon === "string" ? raw.icon : undefined,
    path: typeof raw.path === "string" ? slugify(raw.path) : slugify(raw.title),
    columns: salvageSpan(raw.columns, 3),
    // Same reasoning as the section above: a tab hidden from most of the team
    // must not become visible to them because one card in it went bad.
    visibility: salvageVisibility(raw.visibility),
    sections,
  };
}

/**
 * Keep whatever part of a visibility list still parses.
 *
 * Conditions are independent of each other, so one unreadable clause is no
 * reason to discard the rest — and discarding them all is the direction that
 * REVEALS. If nothing survives, `undefined` would mean "always visible", so a
 * list that had clauses but lost every one of them degrades to a condition that
 * can never be met rather than to no condition at all.
 */
function salvageVisibility(raw: unknown): Condition[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const schema = conditionSchema(MAX_CONDITION_DEPTH);
  const kept: Condition[] = [];
  for (const entry of raw.slice(0, MAX_CONDITIONS)) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) kept.push(parsed.data);
  }
  if (kept.length > 0) return kept;
  return [UNREADABLE_CONDITION];
}

/**
 * "Hidden, because the rule that hid this could not be read."
 *
 * A role nobody holds, rather than an empty `or` — which would also evaluate
 * false but would fail `parseConfigStrict` on the way back out (`roles` requires
 * at least one entry), and a config that renders but cannot be saved would trap
 * the user's next unrelated edit. This one is a legal condition that simply
 * never matches, so the dashboard stays editable and the section stays hidden
 * until someone opens it in the editor and says what they meant.
 */
const UNREADABLE_CONDITION: Condition = {
  kind: "role",
  roles: ["__unreadable_visibility_rule__"],
};

function salvageSpan(raw: unknown, fallback: 1 | 2 | 3 | 4 = 1): 1 | 2 | 3 | 4 {
  return raw === 1 || raw === 2 || raw === 3 || raw === 4 ? raw : fallback;
}

function describeDroppedCard(raw: unknown): string {
  const type =
    raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).type === "string"
      ? (raw as Record<string, string>).type
      : "unknown";
  return `A "${type}" card could not be read and was removed.`;
}

/* ── structural rules zod cannot express ──────────────────────────── */

/**
 * The invariants that span more than one field, checked separately because they
 * are about the config as a WHOLE rather than about any one value.
 */
export function structuralProblems(config: DashboardConfig): string[] {
  const problems: string[] = [];
  const paths = new Set<string>();
  const ids = new Set<string>();

  for (const view of config.views) {
    if (paths.has(view.path)) problems.push(`Two tabs share the address "${view.path}".`);
    paths.add(view.path);
    if (ids.has(view.id)) problems.push("Two tabs share an id.");
    ids.add(view.id);

    const cardCount = countCards(view);
    if (cardCount > LIMITS.cardsPerView) {
      problems.push(`"${view.title}" has ${cardCount} cards; the limit is ${LIMITS.cardsPerView}.`);
    }

    for (const section of view.sections) {
      if (ids.has(section.id)) problems.push("Two sections share an id.");
      ids.add(section.id);
      for (const card of walkCards(section.cards)) {
        if (ids.has(card.id)) problems.push("Two cards share an id.");
        ids.add(card.id);
        const cardProblem = cardProblems(card);
        if (cardProblem) problems.push(cardProblem);
      }
    }
  }
  return problems;
}

/**
 * Per-card rules that depend on the source catalogue.
 *
 * This is where "the field you sorted by is not a field of the source you
 * picked" is caught. Zod can prove `sort.field` is a string; only this can prove
 * it names something real, and letting an unreal name through would mean the
 * compiler had to decide what to do with it at query time — which is exactly the
 * position where a mistake becomes a leak rather than a message.
 */
export function cardProblems(card: CardConfig): string | null {
  if (!isQueryCard(card.type)) return null;
  const query = (card as StatCard).query;
  const source = SOURCES.find((s) => s.id === query.source);
  if (!source) return `Unknown data source "${query.source}".`;
  const has = (key: string) => source.fields.some((f) => f.key === key);

  for (const filter of query.filters) {
    if (!has(filter.field)) return `"${filter.field}" is not a field of ${source.label}.`;
    const field = source.fields.find((f) => f.key === filter.field)!;
    if (field.filterable === false) return `${field.label} cannot be filtered on.`;
  }
  if (query.sort && !has(query.sort.field)) {
    return `Cannot sort by "${query.sort.field}" — it is not a field of ${source.label}.`;
  }
  if (query.sort) {
    const field = source.fields.find((f) => f.key === query.sort!.field)!;
    if (field.sortable === false) return `${field.label} cannot be sorted by.`;
  }
  if (query.periodField && !has(query.periodField)) {
    return `"${query.periodField}" is not a date field of ${source.label}.`;
  }
  if (card.type === "list") {
    for (const column of card.columns) {
      if (!has(column)) return `"${column}" is not a field of ${source.label}.`;
    }
  }
  if (card.type === "chart") {
    if (!has(card.groupBy)) return `Cannot group by "${card.groupBy}".`;
    const field = source.fields.find((f) => f.key === card.groupBy)!;
    if (!field.groupable) return `${field.label} cannot be grouped by.`;
  }
  const metric = (card as StatCard).metric;
  if (metric && metric.fn !== "count") {
    if (!metric.field) return "Choose a field to total.";
    if (!has(metric.field)) return `"${metric.field}" is not a field of ${source.label}.`;
    const field = source.fields.find((f) => f.key === metric.field)!;
    if (!field.aggregatable) return `${field.label} cannot be totalled.`;
  }
  return null;
}

/* ── walking ──────────────────────────────────────────────────────── */

/** Every card in a tree, containers included, depth first. */
export function* walkCards(cards: readonly CardConfig[]): Generator<CardConfig> {
  for (const card of cards) {
    yield card;
    if (card.type === "grid" || card.type === "stack") yield* walkCards(card.cards);
  }
}

export function countCards(view: ViewConfig): number {
  let n = 0;
  for (const section of view.sections) for (const _ of walkCards(section.cards)) n += 1;
  return n;
}

/**
 * Trim a view back to the card budget, from the END.
 *
 * Trimming from the end rather than proportionally keeps the top of the screen —
 * the part anyone actually looks at — identical to what was saved. Only ever
 * reached by a config that was already over the cap when it was stored.
 */
function enforceCardBudget(config: DashboardConfig, dropped: string[]): void {
  for (const view of config.views) {
    let budget = LIMITS.cardsPerView;
    let removed = 0;
    for (const section of view.sections) {
      const kept: CardConfig[] = [];
      for (const card of section.cards) {
        const size = 1 + [...walkCards(card.type === "grid" || card.type === "stack" ? card.cards : [])].length;
        if (size > budget) {
          removed += 1;
          continue;
        }
        budget -= size;
        kept.push(card);
      }
      section.cards = kept;
    }
    if (removed > 0) {
      dropped.push(`"${view.title}" was over the ${LIMITS.cardsPerView}-card limit; ${removed} were removed.`);
    }
  }
}

/* ── small helpers ────────────────────────────────────────────────── */

export function emptyConfig(): DashboardConfig {
  return { version: CONFIG_VERSION, views: [] };
}

/**
 * URL segment for a tab.
 *
 * Anything that is not a letter, digit or dash becomes a dash, runs collapse,
 * and the result is trimmed. An empty result becomes "tab" rather than the empty
 * string, because a view whose path is "" would shadow the dashboard root and
 * make one of the tabs unreachable.
 */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    // Trimmed AGAIN after the cut. The first trim cannot know where the slice
    // will land, so a title long enough to be truncated at a dash boundary ends
    // in one — and this is a stored URL segment, not a display string.
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "tab";
}

/**
 * Refuse anything that is not a path inside this app.
 *
 * `//evil.example` is the case worth naming: browsers read a leading double
 * slash as protocol-relative, so it looks like a path in the config and
 * navigates off-site in practice. A backslash is rejected for the same reason —
 * some parsers normalise it to a slash.
 */
export function normaliseHref(value: string): string | null {
  const href = value.trim();
  if (!href.startsWith("/")) return null;
  if (href.startsWith("//") || href.startsWith("/\\")) return null;
  if (href.includes("\\")) return null;
  return href.slice(0, 200);
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
