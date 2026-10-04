import { johannesburgDateKey } from "./activityDay";

/**
 * Lead score — "who do I contact next?" — the PURE half. No database, no
 * `server-only`: the loader feeds it, the tests drive it directly, and the lead
 * page scores one deal with the very same rules the Today queue ranks by.
 *
 * ── THE REASONS ARE THE PRODUCT ────────────────────────────────────────────
 *
 * Every point a lead earns comes with the sentence that earned it. A number a rep
 * cannot explain is a number a rep ignores, so there are no hidden terms: if a
 * rule adds to the score, it adds a reason. The number only orders the list.
 *
 * ── WHAT IS WEIGHTED MOST, AND WHY ──────────────────────────────────────────
 *
 * Engagement first. A customer who wrote and is waiting on us, or who opened the
 * quote yesterday, is warm NOW and will not be in a week — those outrank every
 * workflow signal. New uncontacted leads come next (speed-to-lead decays by the
 * hour), then commitments we have broken (overdue tasks, silence, a deal stuck
 * past its stage's own limit), then value as a tiebreaker-sized nudge.
 *
 * Days are Johannesburg CALENDAR days, not 24-hour blocks, so "yesterday" in a
 * reason means what the rep reading it at 08:00 means by it.
 */

export type LeadScoreInput = {
  valueCents: number;
  /** open | won | lost. Only open deals score. */
  status: string;
  stageName: string;
  stageIsClosed: boolean;
  daysInStage: number;
  /** The stage's own staleness limit — the board's "stale" and ours must agree. */
  staleAfterDays: number | null;
  /**
   * Latest real touch in EITHER direction: a Communication (not a note) or a
   * completed Activity. Never `Lead.updatedAt`, which moves when anyone edits a
   * field and would make a neglected deal look freshly worked.
   */
  lastContactAt: Date | null;
  lastInboundAt: Date | null;
  /** Latest time the customer opened an unsigned quote. */
  quoteViewedAt: Date | null;
  quoteSentNotSigned: boolean;
  hasOverdueActivity: boolean;
  /** Earliest planned activity (may itself be overdue); null = no next step. */
  nextPlannedActivityAt: Date | null;
  createdAt: Date;
};

export type LeadScore = {
  /** 0–100. */
  score: number;
  /** Heaviest first — the first one is the reason this lead is where it is. */
  reasons: string[];
  /** One short next step. Empty for a closed deal. */
  action: string;
};

/** Points per rule. Exported so tests (and any tuning) read the real numbers. */
export const LEAD_SCORE_WEIGHTS = {
  /** Customer wrote and our side has not touched the deal since. */
  awaitingReply: 40,
  /** Customer wrote recently and we did answer — the conversation is live. */
  recentReply: 15,
  /** Opened the quote within QUOTE_FRESH_DAYS. */
  quoteViewedFresh: 25,
  /** Opened the quote within QUOTE_RECENT_DAYS. */
  quoteViewedRecent: 12,
  quoteSentNotSigned: 8,
  newUncontacted: 30,
  neverContacted: 20,
  overdueActivity: 15,
  /** Base for silence; grows by one per extra day up to NO_CONTACT_MAX_EXTRA. */
  noContact: 10,
  staleInStage: 10,
  noNextStep: 5,
  highValue: 10,
} as const;

export const MAX_LEAD_SCORE = 100;
/** A reply this recent (and answered) still counts as a live conversation. */
export const RECENT_REPLY_DAYS = 3;
export const QUOTE_FRESH_DAYS = 2;
export const QUOTE_RECENT_DAYS = 7;
/** Uncontacted for up to this many days is "new"; after that, "never contacted". */
export const NEW_LEAD_DAYS = 3;
export const NO_CONTACT_DAYS = 7;
export const NO_CONTACT_MAX_EXTRA = 10;
/**
 * R250 000. A single workspace-wide line rather than a per-tenant setting —
 * ponytail: fixed threshold, make it a tenant setting if a tenant's typical deal
 * size sits far from it.
 */
export const HIGH_VALUE_CENTS = 25_000_000;

/** Nothing to chase: the copy when a lead is open but quiet in every rule. */
export const NOTHING_URGENT_ACTION = "Nothing urgent — keep in touch";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole Johannesburg calendar days from `at` to `now` (0 = same day). */
export function calendarDaysAgo(at: Date, now: Date): number {
  const day = (date: Date) => {
    const [y, m, d] = johannesburgDateKey(date).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((day(now) - day(at)) / DAY_MS);
}

/** "today" / "yesterday" / "3 days ago" — for a sentence. */
export function agoPhrase(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

type Hit = { points: number; reason: string; action: string | null };

export function scoreLead(input: LeadScoreInput, now: Date = new Date()): LeadScore {
  // A closed deal has no next step by definition. Both the status and the stage
  // are checked: a lead can sit in a closed stage before its status catches up.
  if (input.status !== "open" || input.stageIsClosed) return { score: 0, reasons: [], action: "" };

  const W = LEAD_SCORE_WEIGHTS;
  const hits: Hit[] = [];

  // ── Engagement ────────────────────────────────────────────────────────────
  // "Awaiting" = the inbound message IS the latest touch. lastContactAt already
  // includes inbound, so equal means nobody on our side has acted since.
  const awaiting =
    input.lastInboundAt !== null &&
    (input.lastContactAt === null || input.lastInboundAt.getTime() >= input.lastContactAt.getTime());
  if (input.lastInboundAt && awaiting) {
    hits.push({
      points: W.awaitingReply,
      reason: `Wrote ${agoPhrase(calendarDaysAgo(input.lastInboundAt, now))} — waiting on our reply`,
      action: "Reply to their message",
    });
  } else if (input.lastInboundAt) {
    const days = calendarDaysAgo(input.lastInboundAt, now);
    if (days <= RECENT_REPLY_DAYS) {
      hits.push({ points: W.recentReply, reason: `Replied ${agoPhrase(days)}`, action: "Keep the conversation going" });
    }
  }

  if (input.quoteViewedAt) {
    const days = calendarDaysAgo(input.quoteViewedAt, now);
    const points = days <= QUOTE_FRESH_DAYS ? W.quoteViewedFresh : days <= QUOTE_RECENT_DAYS ? W.quoteViewedRecent : 0;
    if (points) hits.push({ points, reason: `Opened the quote ${agoPhrase(days)}`, action: "Call while the quote is fresh" });
  }
  if (input.quoteSentNotSigned) {
    hits.push({ points: W.quoteSentNotSigned, reason: "Quote sent — not signed yet", action: "Follow up on the quote" });
  }

  // ── Contact / silence ─────────────────────────────────────────────────────
  // Exclusive with "awaiting": when the customer wrote last, the silence is ours
  // and the awaiting reason already says so in better words.
  if (input.lastContactAt === null) {
    const age = calendarDaysAgo(input.createdAt, now);
    hits.push(
      age <= NEW_LEAD_DAYS
        ? { points: W.newUncontacted, reason: "New lead — not contacted yet", action: "Make first contact" }
        : { points: W.neverContacted, reason: `Never contacted — added ${agoPhrase(age)}`, action: "Make first contact" },
    );
  } else if (!awaiting) {
    const days = calendarDaysAgo(input.lastContactAt, now);
    if (days >= NO_CONTACT_DAYS) {
      hits.push({
        points: W.noContact + Math.min(NO_CONTACT_MAX_EXTRA, days - NO_CONTACT_DAYS),
        reason: `No contact for ${days} days`,
        action: "Check in with the customer",
      });
    }
  }

  // ── Commitments ───────────────────────────────────────────────────────────
  if (input.hasOverdueActivity) {
    hits.push({ points: W.overdueActivity, reason: "Overdue follow-up", action: "Complete the overdue follow-up" });
  }
  if (input.staleAfterDays != null && input.staleAfterDays > 0 && input.daysInStage >= input.staleAfterDays) {
    hits.push({
      points: W.staleInStage,
      reason: `In ${input.stageName} ${input.daysInStage} days — past its ${input.staleAfterDays}-day limit`,
      action: "Move the deal forward or close it",
    });
  }
  if (input.nextPlannedActivityAt === null) {
    hits.push({ points: W.noNextStep, reason: "No next step planned", action: "Plan the next step" });
  }

  // ── Value ─────────────────────────────────────────────────────────────────
  // No action of its own: value says how much a deal matters, never what to do.
  if (input.valueCents >= HIGH_VALUE_CENTS) {
    hits.push({ points: W.highValue, reason: "High-value deal", action: null });
  }

  // Stable sort: on a points tie the rule declared first (engagement) leads.
  hits.sort((a, b) => b.points - a.points);
  const score = Math.min(MAX_LEAD_SCORE, hits.reduce((sum, hit) => sum + hit.points, 0));
  return {
    score,
    reasons: hits.map((hit) => hit.reason),
    action: hits.find((hit) => hit.action)?.action ?? NOTHING_URGENT_ACTION,
  };
}
