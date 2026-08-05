/**
 * Visibility conditions for dashboards, views, sections and cards.
 *
 * ONE MECHANISM, EVERY LEVEL. A dashboard needs "hide this unless it has
 * something in it" in at least four places — a whole tab that is meaningless to
 * a workshop user, a section that is empty out of season, a card with no rows, a
 * button only an owner should see. Giving each level its own flag would be four
 * vocabularies to learn and four places for the same bug. Instead every level
 * carries the same optional `visibility: Condition[]`, evaluated by the same
 * function, and an absent or empty list means "always".
 *
 * That also removes the need for a separate "conditional card" wrapper. A
 * wrapper card whose only job is to hide its child is the same idea expressed as
 * a container, and having both would be exactly the duplication this codebase is
 * trying to get rid of: two ways to hide a card, differing in whether the
 * condition lives on the card or on something wrapped around it.
 *
 * ── WHERE A CONDITION IS EVALUATED, AND WHY IT MATTERS ──────────────────────
 *
 * Conditions split into two groups and the split is a SECURITY boundary, not a
 * performance one:
 *
 *   SERVER-EVALUABLE (`user`, `role`, `permission`, `module`, `time`) depend only
 *   on who is asking and when. They are decided before anything is loaded, so a
 *   card they hide is never queried and its contents never reach the browser.
 *
 *   DATA-DEPENDENT (`data`) reads the signals a card's loader published, so by
 *   definition the query has already run. It buys a quieter screen, not a
 *   cheaper one.
 *
 *   CLIENT-ONLY (`screen`) is a media query. It can only ever be decided in the
 *   browser, which means the content it hides HAS ALREADY BEEN SENT. It is a
 *   layout tool and nothing else — `isSecurityRelevant` exists so the editor can
 *   refuse to let someone reach for it as a privacy control.
 *
 * None of this is the access control. Permission and module gating happens
 * before any of it, per card source, in the compiler — a condition is a
 * PREFERENCE about what to show, and a user who deletes every condition from
 * their own config must not thereby see one extra row.
 */
import type { ConditionOperator } from "@/lib/journeyTypes";

/**
 * The comparison vocabulary is borrowed WHOLESALE from the journey builder
 * rather than restated. A user who has learned "is / is not / contains / is
 * greater than / is empty" building an automation should not meet a second,
 * subtly different set of operators here, and the alternative — two operator
 * unions that drift apart one release at a time — is the specific failure this
 * codebase keeps consolidating away from.
 *
 * What is NOT shared is the FIELD vocabulary. Journey conditions name record
 * fields (`lead.source`); dashboard conditions name signals a card published
 * about its own result set (`count`, `total`). Forcing both through one field
 * list would put dashboard-only names in the journey field picker meaning
 * nothing, and vice versa.
 */
export type { ConditionOperator };

export type DataCondition = {
  kind: "data";
  /** A signal the card's loader published, e.g. "count" or "total". */
  field: string;
  operator: ConditionOperator;
  value?: unknown;
};

/** Named individuals. Stored as user ids; the editor resolves them to names. */
export type UserCondition = { kind: "user"; users: string[] };

/** Any one of these roles. */
export type RoleCondition = { kind: "role"; roles: string[] };

/**
 * Holds any one of these permissions.
 *
 * Worth being blunt about what this is FOR, because it looks like access
 * control and is not: it is how you keep a card out of the way of people it
 * would only confuse. The card's own source already refuses data to anyone
 * lacking the permission, whether or not this condition is present.
 */
export type PermissionCondition = { kind: "permission"; permissions: string[] };

/** The tenant has any one of these module packs switched on. */
export type ModuleCondition = { kind: "module"; modules: string[] };

/**
 * Time of day and/or day of week, in the workspace's timezone.
 *
 * `after`/`before` are "HH:MM". A window that wraps midnight (after 22:00,
 * before 06:00) is supported and is the reason this is not a naive `>= && <=`.
 */
export type TimeCondition = {
  kind: "time";
  after?: string;
  before?: string;
  /** 0 = Sunday, matching Date#getDay. Empty or absent means every day. */
  weekdays?: number[];
};

/** Viewport width. CLIENT-ONLY — see the header note. */
export type ScreenCondition = { kind: "screen"; breakpoints: Breakpoint[] };

export type AndCondition = { kind: "and"; conditions: Condition[] };
export type OrCondition = { kind: "or"; conditions: Condition[] };
export type NotCondition = { kind: "not"; condition: Condition };

export type Condition =
  | DataCondition
  | UserCondition
  | RoleCondition
  | PermissionCondition
  | ModuleCondition
  | TimeCondition
  | ScreenCondition
  | AndCondition
  | OrCondition
  | NotCondition;

export type ConditionKind = Condition["kind"];

export const CONDITION_KINDS = [
  "data",
  "user",
  "role",
  "permission",
  "module",
  "time",
  "screen",
  "and",
  "or",
  "not",
] as const;

export const BREAKPOINTS = ["mobile", "tablet", "desktop"] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/**
 * Tailwind's own breakpoints, so a card hidden on "mobile" disappears at exactly
 * the width the grid collapses to one column. Picking independent numbers here
 * would put the card's visibility a few pixels out of step with the layout it
 * lives in.
 */
export const BREAKPOINT_QUERY: Record<Breakpoint, string> = {
  mobile: "(max-width: 767px)",
  tablet: "(min-width: 768px) and (max-width: 1023px)",
  desktop: "(min-width: 1024px)",
};

/**
 * How deep a condition tree may nest.
 *
 * Conditions arrive as JSON from a user's own saved config, so the recursion
 * below is walking untrusted input. A cap is the difference between a bad
 * config being rejected and a bad config taking down the home page with a stack
 * overflow. Three is well past anything anyone builds in the editor, which only
 * offers one level of grouping.
 */
export const MAX_CONDITION_DEPTH = 3;

/** How many conditions one list may hold, at any single level. */
export const MAX_CONDITIONS = 12;

/* ── evaluation context ───────────────────────────────────────────── */

/**
 * Everything a condition can ask about, resolved once per request.
 *
 * `screen` is deliberately ABSENT. There is no server-side answer to a media
 * query, and inventing one — guessing from a user-agent, defaulting to desktop —
 * would make a card's visibility depend on a guess. Screen conditions are
 * carried through evaluation untouched (they evaluate to `true` on the server)
 * and applied in the browser, which is the only place the answer exists.
 */
export type ConditionContext = {
  userId: string;
  role: string;
  permissions: ReadonlySet<string>;
  modules: ReadonlySet<string>;
  /** The render's single clock — see dashboardWindow(). */
  now: Date;
  /** Minutes past midnight in the workspace timezone, and the weekday there. */
  localMinutes: number;
  localWeekday: number;
  /** Signals published by the card being evaluated. Empty above card level. */
  signals?: Record<string, unknown>;
};

/* ── the operator table, shared with the journey builder's semantics ── */

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Compare one signal against one expected value.
 *
 * Numeric comparisons coerce BOTH sides and refuse if either fails to convert,
 * rather than falling back to string comparison. A silent string compare is how
 * "value greater than 90" starts matching 100 as `"100" < "90"`, and on a
 * dashboard that produces a card that is confidently, quietly wrong.
 */
export function compare(actual: unknown, operator: ConditionOperator, expected: unknown): boolean {
  switch (operator) {
    case "is_empty":
      return isEmpty(actual);
    case "is_not_empty":
      return !isEmpty(actual);
    case "equals":
      return String(actual) === String(expected);
    case "not_equals":
      return String(actual) !== String(expected);
    case "contains":
      return Array.isArray(actual)
        ? actual.map(String).includes(String(expected))
        : String(actual).toLowerCase().includes(String(expected).toLowerCase());
    case "not_contains":
      return !compare(actual, "contains", expected);
    case "in": {
      const list = Array.isArray(expected)
        ? expected
        : String(expected)
            .split(",")
            .map((s) => s.trim());
      return list.map(String).includes(String(actual));
    }
    case "greater_than":
    case "greater_or_equal":
    case "less_than":
    case "less_or_equal": {
      const a = asNumber(actual);
      const b = asNumber(expected);
      if (a === null || b === null) return false;
      if (operator === "greater_than") return a > b;
      if (operator === "greater_or_equal") return a >= b;
      if (operator === "less_than") return a < b;
      return a <= b;
    }
    default:
      // An operator this build does not know. Fail CLOSED: an unrecognised
      // comparison must not be treated as satisfied, or a config written by a
      // newer release would make cards appear rather than disappear.
      return false;
  }
}

/* ── time ─────────────────────────────────────────────────────────── */

/** "HH:MM" → minutes past midnight, or null if it is not a time. */
export function parseClock(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Is `minutes` inside the window?
 *
 * Handles the wrapping case explicitly. A night-shift card configured "after
 * 22:00, before 06:00" describes a window that crosses midnight; the naive
 * `after <= x && x < before` is empty for every such window, so the card would
 * never appear and the bug would only be visible to whoever works nights.
 */
export function withinWindow(minutes: number, after: number | null, before: number | null): boolean {
  if (after === null && before === null) return true;
  if (after === null) return minutes < before!;
  if (before === null) return minutes >= after;
  if (after === before) return true;
  return after < before ? minutes >= after && minutes < before : minutes >= after || minutes < before;
}

/* ── the evaluator ────────────────────────────────────────────────── */

/**
 * Does this list of conditions admit the thing it is attached to?
 *
 * An ABSENT or EMPTY list means yes. That is the common case by a wide margin —
 * most cards are unconditional — and spelling it out here means every caller can
 * pass `card.visibility` straight through without a null check of its own.
 *
 * Multiple entries are AND-ed, matching how the editor reads ("show this card
 * when: X, and: Y") and how the journey builder's top-level group behaves. `or`
 * is available as an explicit group.
 */
export function conditionsMet(
  conditions: readonly Condition[] | undefined,
  context: ConditionContext,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((condition) => conditionMet(condition, context));
}

export function conditionMet(condition: Condition, context: ConditionContext): boolean {
  switch (condition.kind) {
    case "and":
      return condition.conditions.every((c) => conditionMet(c, context));
    case "or":
      // An EMPTY `or` is false, not true. `[].some()` already returns false, but
      // it is worth being deliberate: an or-group the user emptied out has no
      // satisfied branch, and inheriting `and`'s vacuous-truth would make
      // clearing a group turn a hidden card on.
      return condition.conditions.some((c) => conditionMet(c, context));
    case "not":
      return !conditionMet(condition.condition, context);
    case "data":
      return compare(context.signals?.[condition.field], condition.operator, condition.value);
    case "user":
      return condition.users.includes(context.userId);
    case "role":
      return condition.roles.includes(context.role);
    case "permission":
      return condition.permissions.some((key) => context.permissions.has(key));
    case "module":
      return condition.modules.some((id) => context.modules.has(id));
    case "time":
      if (condition.weekdays && condition.weekdays.length > 0) {
        if (!condition.weekdays.includes(context.localWeekday)) return false;
      }
      return withinWindow(
        context.localMinutes,
        parseClock(condition.after),
        parseClock(condition.before),
      );
    case "screen":
      // Undecidable here — see the header. True on the server, narrowed in the
      // browser. Never load-bearing for privacy.
      return true;
    default:
      // A condition kind from a newer release. Fail CLOSED, same reasoning as
      // the operator default: an unknown rule must hide, not reveal.
      return false;
  }
}

/* ── questions the editor and the loader ask about a condition ────── */

/**
 * Does this condition need the card's data to decide?
 *
 * The loader uses this to know whether it can skip a card entirely. A card whose
 * conditions are all server-evaluable and all false is never queried; one with
 * any data condition has to run first and may be discarded afterwards, which is
 * the honest cost of "hide when empty".
 */
export function needsData(conditions: readonly Condition[] | undefined): boolean {
  return (conditions ?? []).some(function walk(condition: Condition): boolean {
    switch (condition.kind) {
      case "data":
        return true;
      case "and":
      case "or":
        return condition.conditions.some(walk);
      case "not":
        return walk(condition.condition);
      default:
        return false;
    }
  });
}

/**
 * Can this condition be settled before anything is loaded or sent?
 *
 * True only when NOTHING in the tree needs the browser or the card's rows. The
 * loader uses it to drop a card before its query runs.
 */
export function isServerDecidable(conditions: readonly Condition[] | undefined): boolean {
  return (conditions ?? []).every(function walk(condition: Condition): boolean {
    switch (condition.kind) {
      case "data":
      case "screen":
        return false;
      case "and":
      case "or":
        return condition.conditions.every(walk);
      case "not":
        return walk(condition.condition);
      default:
        return true;
    }
  });
}

/**
 * Would someone reasonably MISTAKE this for a privacy control?
 *
 * `screen` hides in the browser, so whatever it hides was delivered first. The
 * editor shows a plain warning when one is added to a card — not a refusal,
 * because hiding a wide table on a phone is a perfectly good reason to use it,
 * but nobody should reach for it believing it keeps anything back.
 */
export function isSecurityRelevant(condition: Condition): boolean {
  switch (condition.kind) {
    case "screen":
      return true;
    case "and":
    case "or":
      return condition.conditions.some(isSecurityRelevant);
    case "not":
      return isSecurityRelevant(condition.condition);
    default:
      return false;
  }
}

/** Every `screen` condition in the tree, so the client knows what to watch. */
export function screenBreakpoints(conditions: readonly Condition[] | undefined): Breakpoint[] {
  const out = new Set<Breakpoint>();
  (conditions ?? []).forEach(function walk(condition: Condition): void {
    switch (condition.kind) {
      case "screen":
        condition.breakpoints.forEach((b) => out.add(b));
        break;
      case "and":
      case "or":
        condition.conditions.forEach(walk);
        break;
      case "not":
        walk(condition.condition);
        break;
      default:
        break;
    }
  });
  return [...out];
}

/* ── the clock a `time` condition is judged against ───────────────── */

/**
 * The workspace's timezone, not the server's.
 *
 * A `time` condition is written by somebody who means their own working day —
 * "show the workshop board between seven and five". The server runs in UTC, and
 * on a UTC clock a South African working day starts at five in the morning, so
 * a card configured for business hours would appear two hours early and vanish
 * two hours early. Nobody reports that as a timezone bug; they report that the
 * dashboard is wrong in the afternoon.
 *
 * `Intl` rather than a +02:00 constant, because an offset is a fact about a
 * DATE, not about a place. South Africa does not observe daylight saving today,
 * but hardcoding the offset would bury that assumption in a dashboard module,
 * and the first person to hit it would be looking at a card, not at this file.
 */
export const WORKSPACE_TIMEZONE = "Africa/Johannesburg";

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Local wall-clock minutes past midnight, and the local weekday.
 *
 * Both come from ONE `formatToParts` call, which is not just tidiness: reading
 * the hour and the weekday from separate formatter calls could straddle
 * midnight and report 00:30 on the previous day.
 */
export function localClock(
  now: Date,
  timeZone: string = WORKSPACE_TIMEZONE,
): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-ZA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  // Some environments render midnight as hour "24" under hour12: false. That
  // means zero minutes past midnight, not a twenty-fifth hour, and left
  // unhandled it puts every midnight card outside every window.
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekday = WEEKDAY_INDEX[get("weekday").slice(0, 3)] ?? now.getDay();
  return {
    minutes: Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 0,
    weekday,
  };
}
