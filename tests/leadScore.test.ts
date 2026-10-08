import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HIGH_VALUE_CENTS,
  LEAD_SCORE_WEIGHTS as W,
  MAX_LEAD_SCORE,
  NEW_LEAD_DAYS,
  NOTHING_URGENT_ACTION,
  NO_CONTACT_DAYS,
  NO_CONTACT_MAX_EXTRA,
  QUOTE_FRESH_DAYS,
  QUOTE_RECENT_DAYS,
  RECENT_REPLY_DAYS,
  agoPhrase,
  calendarDaysAgo,
  scoreLead,
  type LeadScoreInput,
} from "../src/lib/leadScore";

// 10:00 SAST on a Sunday. Fixed so every "days ago" below is exact.
const NOW = new Date("2026-10-04T08:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

/** A quiet, healthy open deal: contacted yesterday, next step booked. Scores 0. */
function lead(overrides: Partial<LeadScoreInput> = {}): LeadScoreInput {
  return {
    valueCents: 10_000_000,
    status: "open",
    stageName: "Proposal",
    stageIsClosed: false,
    daysInStage: 2,
    staleAfterDays: 14,
    lastContactAt: daysAgo(1),
    lastInboundAt: null,
    quoteViewedAt: null,
    quoteSentNotSigned: false,
    hasOverdueActivity: false,
    nextPlannedActivityAt: daysAgo(-2),
    createdAt: daysAgo(30),
    ...overrides,
  };
}

test("a healthy deal with nothing to chase scores 0 and says so", () => {
  assert.deepEqual(scoreLead(lead(), NOW), { score: 0, reasons: [], action: NOTHING_URGENT_ACTION });
});

test("won, lost and closed-stage deals never score, whatever their signals", () => {
  const hot: Partial<LeadScoreInput> = { lastInboundAt: daysAgo(0), lastContactAt: daysAgo(0), hasOverdueActivity: true };
  for (const status of ["won", "lost"]) {
    assert.deepEqual(scoreLead(lead({ ...hot, status }), NOW), { score: 0, reasons: [], action: "" });
  }
  assert.equal(scoreLead(lead({ ...hot, stageIsClosed: true }), NOW).score, 0);
});

test("a customer waiting on our reply is the heaviest signal and sets the action", () => {
  const out = scoreLead(lead({ lastInboundAt: daysAgo(1), lastContactAt: daysAgo(1) }), NOW);
  assert.equal(out.score, W.awaitingReply);
  assert.deepEqual(out.reasons, ["Wrote yesterday — waiting on our reply"]);
  assert.equal(out.action, "Reply to their message");
});

test("an unanswered message stays 'waiting' at any age and replaces the silence reason", () => {
  const out = scoreLead(lead({ lastInboundAt: daysAgo(20), lastContactAt: daysAgo(20) }), NOW);
  assert.deepEqual(out.reasons, ["Wrote 20 days ago — waiting on our reply"]);
  assert.ok(!out.reasons.some((r) => r.startsWith("No contact")));
});

test("once we have replied, a recent inbound is a live conversation, not a wait", () => {
  const answered = scoreLead(lead({ lastInboundAt: daysAgo(2), lastContactAt: daysAgo(1) }), NOW);
  assert.equal(answered.score, W.recentReply);
  assert.deepEqual(answered.reasons, ["Replied 2 days ago"]);
  assert.equal(answered.action, "Keep the conversation going");

  const old = scoreLead(lead({ lastInboundAt: daysAgo(RECENT_REPLY_DAYS + 1), lastContactAt: daysAgo(1) }), NOW);
  assert.equal(old.score, 0);
});

test("a quote opened recently is weighted by how fresh the view is", () => {
  const fresh = scoreLead(lead({ quoteViewedAt: daysAgo(1) }), NOW);
  assert.equal(fresh.score, W.quoteViewedFresh);
  assert.deepEqual(fresh.reasons, ["Opened the quote yesterday"]);
  assert.equal(fresh.action, "Call while the quote is fresh");

  assert.equal(scoreLead(lead({ quoteViewedAt: daysAgo(QUOTE_FRESH_DAYS) }), NOW).score, W.quoteViewedFresh);
  assert.equal(scoreLead(lead({ quoteViewedAt: daysAgo(QUOTE_FRESH_DAYS + 1) }), NOW).score, W.quoteViewedRecent);
  assert.equal(scoreLead(lead({ quoteViewedAt: daysAgo(QUOTE_RECENT_DAYS) }), NOW).score, W.quoteViewedRecent);
  assert.equal(scoreLead(lead({ quoteViewedAt: daysAgo(QUOTE_RECENT_DAYS + 1) }), NOW).score, 0);
});

test("an outstanding unsigned quote adds its own reason", () => {
  const out = scoreLead(lead({ quoteSentNotSigned: true }), NOW);
  assert.equal(out.score, W.quoteSentNotSigned);
  assert.deepEqual(out.reasons, ["Quote sent — not signed yet"]);
  assert.equal(out.action, "Follow up on the quote");
});

test("brand-new uncontacted leads outrank old never-contacted ones", () => {
  const fresh = scoreLead(lead({ lastContactAt: null, createdAt: daysAgo(0) }), NOW);
  assert.equal(fresh.score, W.newUncontacted);
  assert.deepEqual(fresh.reasons, ["New lead — not contacted yet"]);
  assert.equal(fresh.action, "Make first contact");

  assert.equal(scoreLead(lead({ lastContactAt: null, createdAt: daysAgo(NEW_LEAD_DAYS) }), NOW).score, W.newUncontacted);
  const stale = scoreLead(lead({ lastContactAt: null, createdAt: daysAgo(12) }), NOW);
  assert.equal(stale.score, W.neverContacted);
  assert.deepEqual(stale.reasons, ["Never contacted — added 12 days ago"]);
});

test("silence starts counting at NO_CONTACT_DAYS and grows to a ceiling", () => {
  assert.equal(scoreLead(lead({ lastContactAt: daysAgo(NO_CONTACT_DAYS - 1) }), NOW).score, 0);
  const nine = scoreLead(lead({ lastContactAt: daysAgo(9) }), NOW);
  assert.equal(nine.score, W.noContact + (9 - NO_CONTACT_DAYS));
  assert.deepEqual(nine.reasons, ["No contact for 9 days"]);
  assert.equal(nine.action, "Check in with the customer");
  assert.equal(scoreLead(lead({ lastContactAt: daysAgo(200) }), NOW).score, W.noContact + NO_CONTACT_MAX_EXTRA);
});

test("overdue work, a stale stage and no next step each explain themselves", () => {
  const overdue = scoreLead(lead({ hasOverdueActivity: true }), NOW);
  assert.deepEqual([overdue.score, overdue.reasons, overdue.action], [W.overdueActivity, ["Overdue follow-up"], "Complete the overdue follow-up"]);

  const stale = scoreLead(lead({ daysInStage: 14, staleAfterDays: 14 }), NOW);
  assert.equal(stale.score, W.staleInStage);
  assert.deepEqual(stale.reasons, ["In Proposal 14 days — past its 14-day limit"]);

  const noStep = scoreLead(lead({ nextPlannedActivityAt: null }), NOW);
  assert.deepEqual([noStep.score, noStep.reasons, noStep.action], [W.noNextStep, ["No next step planned"], "Plan the next step"]);
});

test("a stage with no staleness limit (null or 0) is never stale", () => {
  assert.equal(scoreLead(lead({ daysInStage: 400, staleAfterDays: null }), NOW).score, 0);
  assert.equal(scoreLead(lead({ daysInStage: 400, staleAfterDays: 0 }), NOW).score, 0);
});

test("value nudges the score but never decides the action", () => {
  const big = scoreLead(lead({ valueCents: HIGH_VALUE_CENTS }), NOW);
  assert.deepEqual(big, { score: W.highValue, reasons: ["High-value deal"], action: NOTHING_URGENT_ACTION });
  assert.equal(scoreLead(lead({ valueCents: HIGH_VALUE_CENTS - 1 }), NOW).score, 0);

  const bigAndStale = scoreLead(lead({ valueCents: HIGH_VALUE_CENTS, nextPlannedActivityAt: null }), NOW);
  assert.equal(bigAndStale.action, "Plan the next step");
});

test("reasons are ordered heaviest first and the action follows the heaviest", () => {
  const out = scoreLead(
    lead({ quoteViewedAt: daysAgo(0), hasOverdueActivity: true, lastInboundAt: daysAgo(0), lastContactAt: daysAgo(0) }),
    NOW,
  );
  assert.deepEqual(out.reasons, ["Wrote today — waiting on our reply", "Opened the quote today", "Overdue follow-up"]);
  assert.equal(out.action, "Reply to their message");
  assert.equal(out.score, W.awaitingReply + W.quoteViewedFresh + W.overdueActivity);
});

test("engagement outranks a pile of workflow signals", () => {
  const engaged = scoreLead(lead({ lastInboundAt: daysAgo(0), lastContactAt: daysAgo(0) }), NOW).score;
  const neglected = scoreLead(lead({ hasOverdueActivity: true, nextPlannedActivityAt: null, daysInStage: 30 }), NOW).score;
  assert.ok(engaged > neglected, `${engaged} should beat ${neglected}`);
});

test("the score is capped at MAX_LEAD_SCORE", () => {
  const out = scoreLead(
    lead({
      lastInboundAt: daysAgo(0),
      lastContactAt: daysAgo(0),
      quoteViewedAt: daysAgo(0),
      quoteSentNotSigned: true,
      hasOverdueActivity: true,
      daysInStage: 99,
      nextPlannedActivityAt: null,
      valueCents: HIGH_VALUE_CENTS * 2,
    }),
    NOW,
  );
  assert.equal(out.score, MAX_LEAD_SCORE);
});

test("days are Johannesburg calendar days, not 24-hour blocks", () => {
  // 23:30 SAST yesterday is "yesterday" at 00:30 SAST today, one hour later.
  const justAfterMidnight = new Date("2026-10-03T22:30:00Z"); // 00:30 SAST on the 4th
  assert.equal(calendarDaysAgo(new Date("2026-10-03T21:30:00Z"), justAfterMidnight), 1);
  // And 01:00 UTC on the 4th is still the 4th in SAST — same day as 10:00 SAST.
  assert.equal(calendarDaysAgo(new Date("2026-10-04T01:00:00Z"), NOW), 0);
  assert.deepEqual([agoPhrase(0), agoPhrase(1), agoPhrase(5)], ["today", "yesterday", "5 days ago"]);
});
