import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ATTENTION_WEIGHTS,
  MAX_ATTENTION_SCORE,
  MIN_DISMISS_REASON,
  attentionBand,
  compareAttention,
  dismissReasonError,
  isDismissed,
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

test("A REASON IS REQUIRED TO DISMISS, and a token one does not count", () => {
  // This is the one screen whose job is to make sure nothing is forgotten, so the
  // only way off it must be accountable. A one-click dismiss is a button that
  // makes work disappear, and "someone clicked something" is not an answer to
  // "why did nobody chase this deal".
  assert.ok(dismissReasonError("") != null, "empty is refused");
  assert.ok(dismissReasonError("   ") != null, "whitespace is not a reason");
  assert.ok(dismissReasonError("ok") != null, "…nor is a token one");
  assert.ok(dismissReasonError("x".repeat(MIN_DISMISS_REASON - 1)) != null, "one short still fails");
  assert.equal(dismissReasonError("x".repeat(MIN_DISMISS_REASON)), null, "the boundary passes");
  assert.equal(dismissReasonError("Customer asked us to call back in March"), null);
});

test("the minimum matches the one used for overriding a stage rule", () => {
  // Two different minimums for two justification fields in the same product is a
  // distinction nobody can defend when asked.
  //
  // Compared only WHEN the other one exists. `stageGate.ts` arrives with #527,
  // which is a separate unmerged branch — asserting against it unconditionally
  // would make this branch's tests depend on that branch's files, which is how a
  // green PR fails the moment it is checked out on its own. It ties itself back
  // once both have landed.
  let stageGate: string | null = null;
  try {
    stageGate = shipped("src/lib/stageGate.ts");
  } catch {
    stageGate = null;
  }
  assert.equal(MIN_DISMISS_REASON, 10, "the value itself is pinned either way");
  if (!stageGate) return;
  const declared = stageGate.match(/export const MIN_OVERRIDE_REASON = (\d+)/);
  assert.ok(declared, "MIN_OVERRIDE_REASON must still exist to compare against");
  assert.equal(MIN_DISMISS_REASON, Number(declared[1]), "the two justification minimums must agree");
});

test("dismissal is a flag, not a deadline", () => {
  // It stays off the list until somebody puts it back. NULL is "still listed",
  // which is what every existing row already is — hence no backfill.
  assert.equal(isDismissed(null), false);
  assert.equal(isDismissed(undefined), false);
  assert.equal(isDismissed(new Date("2020-01-01T00:00:00Z")), true, "however long ago");
});

test("dismissed leads are shown WITH their reasons, not counted", () => {
  // "Why is this not here" is the question the reason exists to answer, and a
  // bare number cannot. A shorter list than expected is otherwise
  // indistinguishable from a broken one.
  const loader = shipped("src/lib/attention/load.ts");
  assert.match(loader, /if \(isDismissed\(lead\.attentionDismissedAt\)\)/);
  assert.match(loader, /reason: lead\.attentionDismissReason \?\? ""/);
  const page = shipped("src/app/(app)/leads/attention/page.tsx");
  assert.match(page, /dismissed\.length > 0 &&/);
  assert.match(page, /\{lead\.reason\}/, "the reason has to be rendered, not just carried");
  assert.match(page, /RestoreAttentionButton/, "and there must be a way back");
});

test("the server enforces the reason, not just the dialog", () => {
  // A Server Action is a public endpoint. A client that skipped the form would
  // otherwise write an empty justification — worse than no field at all, because
  // the audit trail would look complete.
  const action = shipped("src/app/actions/attention.ts");
  const check = action.indexOf("dismissReasonError(reason)");
  const write = action.indexOf("prisma.$transaction(");
  assert.ok(check > 0 && check < write, "validated before anything is written");
  assert.match(action, /if \(invalid\) return \{ ok: false, error: invalid \}/);
  // The dialog shows the SAME sentence the server would have replied with.
  assert.match(shipped("src/components/DismissAttentionButton.tsx"), /dismissReasonError\(reason\)/);
});

test("restoring needs no reason, and clears the old one", () => {
  // The asymmetry is deliberate: restoring ADDS work to a queue and needs no
  // justification. Keeping a stale reason on a live row would have it read as
  // current the next time somebody dismissed the deal.
  const action = shipped("src/app/actions/attention.ts");
  const restore = action.slice(action.indexOf("export async function restoreLeadAttention"));
  assert.doesNotMatch(restore, /dismissReasonError/);
  assert.match(restore, /attentionDismissedAt: null, attentionDismissReason: null/);
});

test("there is no reasonless way off the list", () => {
  // The snooze button was exactly that, and is gone rather than hidden.
  assert.throws(() => src("src/components/SnoozeAttentionButton.tsx"));
  for (const rel of [
    "src/lib/attention/score.ts",
    "src/lib/attention/load.ts",
    "src/app/actions/attention.ts",
    "src/app/(app)/leads/attention/page.tsx",
  ]) {
    assert.doesNotMatch(shipped(rel), /snooze/i, `${rel} must not offer a reasonless escape`);
  }
});

/* ── the loader's contracts ─────────────────────────────────────────────── */

test("scope comes from the shared helper, with its documented empty-list rule", () => {
  // `[]` must become an impossible match rather than an absent filter — the bug
  // that turns a permission-scoped list into a full one.
  const loader = shipped("src/lib/attention/load.ts");
  assert.match(loader, /getAccessibleLeadIds\(user\)/);
  assert.match(
    loader,
    /if \(accessibleIds !== null && accessibleIds\.length === 0\) return \{ leads: \[\], dismissed: \[\] \}/,
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

test("both writes are permissioned, scoped, audited and atomic", () => {
  const action = shipped("src/app/actions/attention.ts");
  assert.equal(
    (action.match(/withActingStaffScope\(/g) ?? []).length,
    2,
    "both standalone Server Actions bind their workspace",
  );
  assert.equal(
    (action.match(/requireLeadAccess\(leadId, "leads\.edit"\)/g) ?? []).length,
    2,
    "a read-only viewer must not be able to empty somebody else's queue",
  );
  // A dismissal nobody can account for is what the reason exists to prevent, so
  // the write must not be able to commit without its audit.
  assert.equal((action.match(/prisma\.\$transaction\(/g) ?? []).length, 2);
  assert.equal((action.match(/logAuditStrict\(/g) ?? []).length, 2);
  assert.match(action, /action: "lead\.attention_dismissed"/);
  assert.match(action, /action: "lead\.attention_restored"/);
  // The reason is recorded in the audit summary, not only in the column — the
  // column is overwritten by the next dismissal, the audit is not.
  assert.match(action, /reason: “\$\{trimmed\}”/);
});

test("the dismiss dialog is not optimistic", () => {
  // The row DISAPPEARS on success. An optimistic removal that then failed would
  // leave somebody believing they had dealt with a deal they had not.
  // Anchored on the EARLY RETURN rather than on exact whitespace: the failure
  // branch has to bail out before anything closes the dialog or hides the row.
  const button = shipped("src/components/DismissAttentionButton.tsx");
  const guard = button.indexOf("if (!result.ok)");
  const bail = button.indexOf("return;", guard);
  const close = button.indexOf("toast.success");
  assert.ok(guard > 0, "the result must be checked at all");
  assert.ok(bail > guard && bail < close, "…and must return before the success path runs");
  // …and the confirm button cannot be clicked into an invalid state.
  assert.match(button, /disabled=\{!ready \|\| pending\}/);
});

/* ── the migration ──────────────────────────────────────────────────────── */

test("rows lead with the PERSON, not the product", () => {
  // The first version led with `Lead.title`, which is usually the product name —
  // so two deals for the same model rendered as two identical rows and the list
  // was unreadable at exactly the moment it had several things to show.
  const loader = shipped("src/lib/attention/load.ts");
  assert.match(loader, /name: lead\.name,/);
  assert.match(
    loader,
    /opportunity: lead\.title && lead\.title !== lead\.name \? lead\.title : null/,
    "the opportunity is shown only when it adds something",
  );
  const page = shipped("src/app/(app)/leads/attention/page.tsx");
  assert.match(page, /\{lead\.name\}/);
  assert.doesNotMatch(page, /\{lead\.title\}/, "title is not the row's identity");
});

test("a chatty note cannot push the rest of the list off the screen", () => {
  // A signal's sentence can quote free text somebody typed — an activity summary
  // is often a paragraph, as the first real screenful showed.
  const page = shipped("src/app/(app)/leads/attention/page.tsx");
  assert.match(page, /line-clamp-2/);
  assert.match(page, /title=\{signal\.detail\}/, "the full text stays available on hover");
});

test("the migration is additive, inert and reentrant", () => {
  const sql = src("prisma/migrations/20260814180000_attention_centre/migration.sql");
  const statements = sql.replace(/^\s*--.*$/gm, "");
  assert.match(statements, /ADD COLUMN IF NOT EXISTS "attentionDismissedAt" TIMESTAMP\(3\)/);
  assert.match(statements, /ADD COLUMN IF NOT EXISTS "attentionDismissReason" TEXT/);
  // Nullable with no default: "never dismissed" and "dismissed with an empty
  // reason" must not be the same state, and the second is impossible anyway.
  assert.doesNotMatch(statements, /attentionDismiss\w*"[^;]*NOT NULL/);
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
