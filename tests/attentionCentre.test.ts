import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ATTENTION_WEIGHTS,
  MAX_ATTENTION_SCORE,
  SNOOZE_DAYS,
  attentionBand,
  compareAttention,
  isSnoozed,
  needsAttention,
  scoreAttention,
  type AttentionSignal,
  type AttentionSignalKind,
} from "../src/lib/attention/score";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * The Attention Centre replaces one line:
 *
 *   const needsAttention = !attentionOnly || lead.noNextStep || … || isStale(…)
 *
 * A boolean can say "interesting" and nothing else — it cannot rank and cannot
 * explain. Everything below runs the real scorer; the ranking DECISIONS are what
 * is worth pinning, because they are the ones that will be argued about.
 */

const signal = (kind: AttentionSignalKind, detail = "x"): AttentionSignal => ({
  kind,
  weight: ATTENTION_WEIGHTS[kind],
  detail,
});

/* ── the score ──────────────────────────────────────────────────────────── */

test("no signals is not attention", () => {
  assert.equal(needsAttention([]), false);
  assert.equal(scoreAttention([]), 0);
  assert.equal(attentionBand(0), "none");
});

test("one waiting customer is urgent on its own", () => {
  // The band table and the weight table must agree: `urgent` starts at 40 because
  // 40 is exactly `unanswered_inbound`. Two opinions about the same threshold is
  // how a badge comes to disagree with the list it is on.
  assert.equal(ATTENTION_WEIGHTS.unanswered_inbound, 40);
  assert.equal(attentionBand(scoreAttention([signal("unanswered_inbound")])), "urgent");
});

test("the score is a sum, capped", () => {
  const everything = (Object.keys(ATTENTION_WEIGHTS) as AttentionSignalKind[]).map((k) => signal(k));
  const uncapped = everything.reduce((sum, s) => sum + s.weight, 0);
  assert.ok(uncapped > MAX_ATTENTION_SCORE, "the fixture must actually exceed the cap");
  assert.equal(scoreAttention(everything), MAX_ATTENTION_SCORE);
});

test("bands are contiguous and ordered", () => {
  // No gap where a real score lands in no band at all.
  assert.equal(attentionBand(1), "watch");
  assert.equal(attentionBand(19), "watch");
  assert.equal(attentionBand(20), "act");
  assert.equal(attentionBand(39), "act");
  assert.equal(attentionBand(40), "urgent");
  assert.equal(attentionBand(100), "urgent");
});

/* ── the ranking decision ───────────────────────────────────────────────── */

test("VALUE IS A TIEBREAK, NOT A MULTIPLIER", () => {
  // The decision most likely to be argued with, so it is pinned with the exact
  // case that makes people uncomfortable: a R2m deal with one signal sorts BELOW
  // a R40k deal with three.
  //
  // The trade is deliberate. A multiplicative value term makes the number
  // unexplainable — "why is this 63?" — and legibility is the entire reason for
  // replacing a boolean.
  const big = { score: 20, valueCents: 200_000_000, id: "big" };
  const small = { score: 70, valueCents: 4_000_000, id: "small" };
  assert.ok(compareAttention(big, small) > 0, "the smaller, more urgent deal comes first");

  // Value decides only when the scores are equal.
  const a = { score: 40, valueCents: 100, id: "a" };
  const b = { score: 40, valueCents: 999, id: "b" };
  assert.ok(compareAttention(a, b) > 0, "…and then the bigger one wins");
});

test("the order is total, so the list does not shuffle between refreshes", () => {
  // Without the id as a final key, two identical rows can swap on every request
  // and the page looks unstable for no reason a user can see.
  const a = { score: 40, valueCents: 100, id: "aaa" };
  const b = { score: 40, valueCents: 100, id: "bbb" };
  assert.ok(compareAttention(a, b) < 0);
  assert.ok(compareAttention(b, a) > 0);
  assert.equal(compareAttention(a, a), 0);
});

/* ── snoozing ───────────────────────────────────────────────────────────── */

test("a snooze expires rather than needing to be cleared", () => {
  // NULL and "elapsed" are the same state, which is why the column needed no
  // backfill and why nothing has to sweep it.
  const now = new Date("2026-08-14T12:00:00Z");
  assert.equal(isSnoozed(null, now), false);
  assert.equal(isSnoozed(undefined, now), false);
  assert.equal(isSnoozed(new Date("2026-08-13T12:00:00Z"), now), false, "yesterday is not a snooze");
  assert.equal(isSnoozed(new Date("2026-08-15T12:00:00Z"), now), true);
});

test("snoozed leads are counted, not silently dropped", () => {
  // A shorter list than expected is indistinguishable from a broken one, and a
  // snooze somebody else set is exactly what you would want to know about.
  const loader = shipped("src/lib/attention/load.ts");
  assert.match(loader, /snoozedCount\+\+;/);
  assert.match(loader, /if \(isSnoozed\(lead\.attentionSnoozedUntil, now\)\)/);
  const page = shipped("src/app/(app)/leads/attention/page.tsx");
  assert.match(page, /snoozedCount > 0 &&/, "and the page has to say so");
});

/* ── the loader's contracts ─────────────────────────────────────────────── */

test("scope comes from the shared helper, with its documented empty-list rule", () => {
  // `[]` must become an impossible match rather than an absent filter — the bug
  // that turns a permission-scoped list into a full one.
  const loader = shipped("src/lib/attention/load.ts");
  assert.match(loader, /getAccessibleLeadIds\(user\)/);
  assert.match(
    loader,
    /if \(accessibleIds !== null && accessibleIds\.length === 0\) return \{ leads: \[\], snoozedCount: 0 \}/,
  );
  assert.match(loader, /accessibleIds === null \? \{\} : \{ id: \{ in: accessibleIds \} \}/);
});

test("every signal query uses the GUARDED client", () => {
  // The counter-example lives in this same feature area: every SalesPipeline path
  // used basePrisma, which is how making a pipeline default in one workspace
  // cleared it in every other one. A list that says what to work on next must not
  // be able to name another tenant's deals.
  for (const rel of ["src/lib/attention/signals.ts", "src/lib/attention/load.ts"]) {
    assert.doesNotMatch(shipped(rel), /basePrisma/, `${rel} must never use the bypass client`);
  }
});

test("closed leads are excluded at the source", () => {
  // Every won or lost deal has no next step by definition, so all of them would
  // raise `no_next_step` and the list would be mostly finished work.
  assert.match(shipped("src/lib/attention/load.ts"), /status: "open",\s*\n\s*deletedAt: null,/);
});

test("the id list is chunked, not passed unbounded", () => {
  // `/leads/page.tsx` builds an unbounded Prisma.join(leadIds) today. Same shape,
  // bounded from the start rather than after the incident.
  const signals = shipped("src/lib/attention/signals.ts");
  assert.match(signals, /const ID_CHUNK = 1000;/);
  assert.match(signals, /const batches = chunk\(leadIds, ID_CHUNK\);/);
  // One query per signal family over a batch — never one per lead.
  assert.doesNotMatch(signals, /for \(const leadId of batch\) \{[\s\S]{0,200}await prisma\./);
});

test("no stored score, and no cron to keep one fresh", () => {
  // Two of the five signals are functions of the CLOCK, so a stored score is
  // stale the moment it is written.
  const loader = shipped("src/lib/attention/load.ts");
  assert.match(loader, /export const loadAttentionList = cache\(/, "cache() per request, not per row");
  assert.doesNotMatch(loader, /attentionScore/, "no denormalised column is read");
});

/* ── the write ──────────────────────────────────────────────────────────── */

test("snoozing is permissioned, scoped, audited and atomic", () => {
  const action = shipped("src/app/actions/attention.ts");
  assert.match(action, /withActingStaffScope\(/, "a standalone Server Action binds its workspace");
  assert.match(action, /requireLeadAccess\(leadId, "leads\.edit"\)/, "a viewer must not silence a queue");
  assert.match(action, /prisma\.\$transaction\(/);
  const tx = action.indexOf("prisma.$transaction(");
  assert.ok(action.indexOf("tx.lead.update") > tx, "the write is inside");
  assert.ok(action.indexOf("logAuditStrict(") > tx, "…and so is its audit");
  assert.match(action, /action: snooze \? "lead\.attention_snoozed" : "lead\.attention_woken"/);
});

test("the snooze button is not optimistic", () => {
  // The row DISAPPEARS on success. An optimistic removal that then failed would
  // leave somebody believing they had dealt with a deal they had not — the one
  // outcome this screen exists to prevent.
  const button = shipped("src/components/SnoozeAttentionButton.tsx");
  const setDone = button.indexOf("setDone(true)");
  const guard = button.indexOf("if (!result.ok)");
  assert.ok(guard > 0 && guard < setDone, "the failure path must be taken before the row is hidden");
});

test("the snooze window has one definition", () => {
  assert.equal(SNOOZE_DAYS, 7);
  // The action computes the deadline and the button labels it, both from the
  // pure module — a literal in either would drift from the other.
  assert.match(shipped("src/app/actions/attention.ts"), /SNOOZE_DAYS \* 24 \* 60 \* 60 \* 1000/);
  assert.match(shipped("src/components/SnoozeAttentionButton.tsx"), /\$\{SNOOZE_DAYS\}/);
});

/* ── the migration ──────────────────────────────────────────────────────── */

test("the migration is additive, inert and reentrant", () => {
  const sql = src("prisma/migrations/20260814180000_attention_centre/migration.sql");
  const statements = sql.replace(/^\s*--.*$/gm, "");
  assert.match(statements, /ADD COLUMN IF NOT EXISTS "attentionSnoozedUntil" TIMESTAMP\(3\)/);
  // Nullable with no default: "never snoozed" and "snooze expired" are the same
  // state, so nothing needs backfilling.
  assert.doesNotMatch(statements, /attentionSnoozedUntil"[^;]*NOT NULL/);
  assert.doesNotMatch(statements, /\bUPDATE\b|\bINSERT\b|\bDELETE\b/i, "it must not touch a row");
  // The runner opens no transaction, so every statement carries its own guard.
  assert.equal((statements.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length, 3);
  assert.doesNotMatch(statements, /CONCURRENTLY/, "a failed CONCURRENTLY build leaves an INVALID index");
});

test("the board links to the list instead of replacing its filter", () => {
  // Both are kept: filtering answers "show me only these cards, in their
  // columns"; the list answers "what next, across every stage, and why".
  const board = shipped("src/components/KanbanBoard.tsx");
  assert.match(board, /href="\/leads\/attention"/);
  assert.match(board, /aria-pressed=\{attentionOnly\}/, "the existing toggle survives");
});
