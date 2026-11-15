/**
 * LEARNING FROM OUTCOMES (Sean, 2026-11-14): "DAX notices which follow-ups, messages and timings led to won deals,
 * and proposes updates to the team playbook for the owner to approve."
 *
 * Pure and deterministic, so the numbers are testable: per-deal facts in, findings out, and the playbook's wording
 * built FROM those findings — no model writes it, so it can never cite a figure the data doesn't show. Aggregates
 * only: no customer, no message text, no names.
 */

export type Touch = { at: Date; channel: string };
export type DealFacts = {
  won: boolean;
  /** Hours from the lead coming in to the first touch; null = never touched before it closed. */
  firstTouchHours: number | null;
  touches: number;
  hadCall: boolean;
  /** Days from the quote going out to the next touch: undefined = no quote went out; null = never followed up. */
  quoteFollowUpDays: number | null | undefined;
  /** Days from the customer first opening the quote to the next touch (same undefined / null meaning). */
  viewFollowUpDays: number | null | undefined;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How close a done activity and its timeline message are when they are one event (both are written in one save). */
export const SAME_EVENT_MS = 2 * 60_000;

/**
 * ONE INTERACTION, COUNTED ONCE (review of #1119). Logging a call (logVoiceDebrief) or ticking an activity done with a
 * note (finishActivity) stores it twice: the done Activity and, seconds later, an outbound Communication of the same
 * channel on the same deal. Each done activity is paired with at most one such message; a paired one is dropped. An
 * activity with no message, and a message with no activity, each stay one touch.
 */
export function uniqueTouches(messages: Touch[], done: Touch[], withinMs = SAME_EVENT_MS): Touch[] {
  const used = new Set<number>();
  const unpaired = done.filter((a) => {
    const i = messages.findIndex((m, j) => !used.has(j) && m.channel === a.channel && Math.abs(m.at.getTime() - a.at.getTime()) <= withinMs);
    if (i < 0) return true;
    used.add(i);
    return false;
  });
  return [...messages, ...unpaired];
}

/** Days from `from` to the first touch at or after it, before the deal closed. */
function nextTouchDays(from: Date | null, touches: Touch[]): number | null | undefined {
  if (!from) return undefined;
  const next = touches.find((t) => t.at >= from);
  return next ? (next.at.getTime() - from.getTime()) / DAY : null;
}

/** One closed deal's facts, from its touches (outbound messages and completed calls/meetings), oldest first. */
export function dealFacts(deal: {
  won: boolean;
  createdAt: Date;
  closedAt: Date;
  touches: Touch[];
  quoteSentAt: Date | null;
  quoteViewedAt: Date | null;
}): DealFacts {
  const touches = deal.touches.filter((t) => t.at <= deal.closedAt).sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    won: deal.won,
    firstTouchHours: touches.length ? (touches[0].at.getTime() - deal.createdAt.getTime()) / HOUR : null,
    touches: touches.length,
    hadCall: touches.some((t) => t.channel === "call"),
    quoteFollowUpDays: nextTouchDays(deal.quoteSentAt, touches),
    viewFollowUpDays: nextTouchDays(deal.quoteViewedAt, touches),
  };
}

/** Each habit: what to say, which deals it can apply to, and whether a deal had it. */
const HABITS: { key: string; says: string; applies: (d: DealFacts) => boolean; had: (d: DealFacts) => boolean }[] = [
  { key: "first-contact", says: "Make first contact within a day of a new lead coming in", applies: () => true, had: (d) => d.firstTouchHours !== null && d.firstTouchHours <= 24 },
  { key: "quote-follow-up", says: "Follow up within two days of sending a quote", applies: (d) => d.quoteFollowUpDays !== undefined, had: (d) => d.quoteFollowUpDays != null && d.quoteFollowUpDays <= 2 },
  { key: "opened-quote", says: "Follow up within a day of the customer opening the quote", applies: (d) => d.viewFollowUpDays !== undefined, had: (d) => d.viewFollowUpDays != null && d.viewFollowUpDays <= 1 },
  { key: "phone-call", says: "Phone the customer at least once", applies: () => true, had: (d) => d.hadCall },
  { key: "three-touches", says: "Stay in touch at least three times before the deal closes", applies: () => true, had: (d) => d.touches >= 3 },
];

export type Finding = { key: string; says: string; wonPct: number; lostPct: number; wonDeals: number; lostDeals: number };

/** At least this many won AND lost deals behind a habit, and won deals ahead by at least this many points. */
export const MIN_DEALS_EACH = 10;
export const MIN_GAP_POINTS = 15;

const pct = (n: number, of: number) => Math.round((100 * n) / of);

/**
 * The habits won deals had noticeably more often than lost ones. Only practices that go WITH winning — a habit lost
 * deals had more is not advice anyone can follow. Too few deals on either side, or a small gap: nothing said.
 */
export function findHabits(deals: DealFacts[], minEach = MIN_DEALS_EACH, minGap = MIN_GAP_POINTS): Finding[] {
  const out: Finding[] = [];
  for (const habit of HABITS) {
    const won = deals.filter((d) => d.won && habit.applies(d));
    const lost = deals.filter((d) => !d.won && habit.applies(d));
    if (won.length < minEach || lost.length < minEach) continue;
    const wonPct = pct(won.filter(habit.had).length, won.length);
    const lostPct = pct(lost.filter(habit.had).length, lost.length);
    if (wonPct - lostPct >= minGap) out.push({ key: habit.key, says: habit.says, wonPct, lostPct, wonDeals: won.length, lostDeals: lost.length });
  }
  return out;
}

/* ── When messages get answered ─────────────────────────────────────────── */

export type MessageFact = { saHour: number; replied: boolean };
export type ReplyTiming = { best: string; worst: string; bestPct: number; worstPct: number; bestN: number; worstN: number };
const PARTS = [
  { name: "morning", from: 0, to: 12 },
  { name: "afternoon", from: 12, to: 17 },
  { name: "evening", from: 17, to: 24 },
] as const;
export const MIN_MESSAGES_EACH = 20;

/** The part of the (South African) day whose messages got answered most, against the least — if the gap is real. */
export function replyTiming(messages: MessageFact[], minEach = MIN_MESSAGES_EACH, minGap = MIN_GAP_POINTS): ReplyTiming | null {
  const parts = PARTS.map((p) => {
    const sent = messages.filter((m) => m.saHour >= p.from && m.saHour < p.to);
    return { name: p.name, n: sent.length, pct: sent.length ? pct(sent.filter((m) => m.replied).length, sent.length) : 0 };
  }).filter((p) => p.n >= minEach);
  if (parts.length < 2) return null;
  const sorted = [...parts].sort((a, b) => b.pct - a.pct);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  return best.pct - worst.pct >= minGap ? { best: best.name, worst: worst.name, bestPct: best.pct, worstPct: worst.pct, bestN: best.n, worstN: worst.n } : null;
}

/* ── The proposal ───────────────────────────────────────────────────────── */

export const PLAYBOOK_DESCRIPTION = "What won deals had in common";

/** The playbook's name for the month it was worked out in: one proposal a month, updated until the owner decides. */
export const playbookName = (now: Date) => `won-deal-habits-${now.toISOString().slice(0, 7)}`;

/**
 * The playbook text: each finding with the numbers behind it, written from the findings alone. Words sit between
 * the numbers on purpose, so the memory scan never reads a run of them as a phone number.
 */
export function playbookText(habits: Finding[], timing: ReplyTiming | null, days: number): string | null {
  if (!habits.length && !timing) return null;
  return [
    `From the deals closed in the last ${days} days. Check it fits how you sell before approving.`,
    ...habits.map((f) => `- ${f.says}. Won deals did in ${f.wonPct}% of cases, lost deals in ${f.lostPct}% (${f.wonDeals} won and ${f.lostDeals} lost deals).`),
    ...(timing
      ? [`- Send messages in the ${timing.best}. ${timing.bestPct}% got a reply within two days, against ${timing.worstPct}% in the ${timing.worst} (${timing.bestN} and ${timing.worstN} messages).`]
      : []),
  ].join("\n");
}
