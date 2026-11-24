import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fingerprintOf, type WorkItem } from "../src/lib/myWork/rules";
import { applyDispositions } from "../src/lib/myWork/dispositions";

/**
 * Brief §7 (Phase 6): proactive suggestions from the EXISTING stuck-deal detection — evidence-backed, deduplicated,
 * with a cooldown, and measured — not a second health engine.
 */
const NOW = new Date("2026-11-24T10:00:00+02:00");
const stuck = (days: number, why = "Quote sent, no reply"): WorkItem => ({
  area: "Sales",
  source: { type: "lead", id: "d1" },
  kind: "suggestion",
  title: "Deal",
  reason: `${days} days past Quoted's time limit · ${why}`,
  fingerprint: `stuck:Quoted:${why}`,
  due: NOW,
  href: "/leads/d1",
});

test("a dismissal survives the day count ticking over, but not a new reason", () => {
  const dismissed = [{ itemKey: "lead:d1", action: "dismissed", until: new Date(NOW.getTime() + 30 * 86_400_000), fingerprint: fingerprintOf(stuck(3)) }];
  assert.equal(applyDispositions([stuck(4)], dismissed, NOW).shown.length, 0, "one more day stuck is not a new suggestion");
  assert.equal(applyDispositions([stuck(4, "Customer replied, nobody answered")], dismissed, NOW).shown.length, 1, "a new reason is");
  // Plain suggestions too: "No contact for 12 days" → "13 days" is the same reason.
  assert.equal(fingerprintOf({ reason: "No contact for 12 days" }), fingerprintOf({ reason: "No contact for 13 days" }));
});

test("the detection is the assistant's own — one lookup, reasons never re-derived", () => {
  const src = readFileSync("src/lib/assistantStuckDeals.ts", "utf8");
  assert.match(src, /export async function myStuckDeals/);
  // Mine, open only (a Nurture deal is parked on purpose, not stuck), past the stage's own configurable limit.
  assert.match(src, /where: \{ tenantId: await actingTenantId\(\), deletedAt: null, status: "open", assignedToId: user\.id/);
  // Every open deal of mine is scored before the top five are picked — no row cap, so the worst can't sit past one
  // (review of #1233: 500 with no order missed a deal beyond the first batch).
  const mine = src.slice(src.indexOf("export async function myStuckDeals"));
  assert.doesNotMatch(mine, /take:/);
  assert.match(mine, /\.sort\(\(a, b\) => b\.over - a\.over\)\s*\.slice\(0, limit\)/);
  assert.match(src, /overLimit\(lead\.stageEnteredAt, lead\.stage\.staleAfterDays, now\)/);
  // Both the chat lookup and My Work read reasons through the same one-deal check.
  assert.equal(src.match(/topReasonOf\(user, /g)?.length, 2);
  // No recorded reason → none stated.
  assert.match(src, /reason: typeof topReason === "string" \? null : topReason/);
});

test("in My Work: first, so a deal is one row; evidence linked; urgent from the limit; permission-gated", () => {
  const load = readFileSync("src/lib/myWork/load.ts", "utf8");
  assert.ok(load.indexOf("stuckSuggestions(user, now),") < load.indexOf("salesDeals(user, now),"), "stuck first, so dedupe keeps it");
  assert.match(load, /evidence: deal\.reason \? \{/);
  assert.match(load, /urgent: deal\.over >= STUCK_URGENT_DAYS/);
  assert.match(load, /fingerprint: `stuck:\$\{deal\.stage\}:/);
  assert.match(readFileSync("src/lib/assistantStuckDeals.ts", "utf8"), /myStuckDeals[\s\S]{0,200}hasAnyPermission\(user, "leads\.view_all", "leads\.view_owned"\)/);
  // The page says how fresh it is.
  assert.match(readFileSync("src/app/(app)/work/page.tsx", "utf8"), /as of \$\{time\.format\(now\)\}/);
});

test("measured: how often each kind is dismissed or snoozed — owner only, counts only", () => {
  const extras = readFileSync("src/lib/myWork/extras.ts", "utf8");
  const fn = extras.slice(extras.indexOf("export async function suggestionFeedback"), extras.indexOf("const SOURCE_NAME"));
  assert.match(fn, /if \(user\.role !== "owner"\) return null;/);
  assert.match(fn, /select: \{ itemKey: true, action: true, fingerprint: true \}/);
  // This workspace only, and no cap that would quietly cut the counts.
  assert.match(fn, /where: \{ tenantId: await actingTenantId\(\), updatedAt:/);
  assert.doesNotMatch(fn, /take:/);
  // A SNOOZED stuck deal counts as a stuck deal: the kind comes from the saved reason, whichever the choice —
  // and a snooze now saves it (review of #1233: snoozes were saved with no reason and counted as "worth contacting").
  assert.match(fn, /const kind = row\.fingerprint\?\.startsWith\("stuck:"\) \? "Stuck deals"/);
  const action = readFileSync("src/app/actions/myWork.ts", "utf8");
  assert.match(action, /\{ action: "snoozed", until: snoozeUntil\(days, now\), fingerprint \}/);
  assert.match(readFileSync("src/components/WorkItemMenu.tsx", "utf8"), /name="choice" value=\{`snooze:\$\{choice\.days\}`\} \/>\s*<input type="hidden" name="fingerprint"/);
  // Labelled for what it is: each item once, by its latest choice — not every click.
  assert.match(readFileSync("src/components/myWork/WorkViews.tsx", "utf8"), /each item counted once, by its latest choice/);
});
