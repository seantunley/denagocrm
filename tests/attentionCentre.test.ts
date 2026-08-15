import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ATTENTION_WEIGHTS,
  MAX_ATTENTION_SCORE,
  MAX_SNOOZE_DAYS,
  MIN_ATTENTION_REASON,
  attentionBand,
  compareAttention,
  attentionReasonError,
  isDismissed,
  isSnoozed,
  snoozeDateError,
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
  assert.ok(attentionReasonError("", "dismiss") != null, "empty is refused");
  assert.ok(attentionReasonError("   ", "dismiss") != null, "whitespace is not a reason");
  assert.ok(attentionReasonError("ok", "dismiss") != null, "…nor is a token one");
  assert.ok(attentionReasonError("x".repeat(MIN_ATTENTION_REASON - 1), "dismiss") != null, "one short still fails");
  assert.equal(attentionReasonError("x".repeat(MIN_ATTENTION_REASON), "dismiss"), null, "the boundary passes");
  assert.equal(attentionReasonError("Customer asked us to call back in March", "dismiss"), null);
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
  assert.equal(MIN_ATTENTION_REASON, 10, "the value itself is pinned either way");
  if (!stageGate) return;
  const declared = stageGate.match(/export const MIN_OVERRIDE_REASON = (\d+)/);
  assert.ok(declared, "MIN_OVERRIDE_REASON must still exist to compare against");
  assert.equal(MIN_ATTENTION_REASON, Number(declared[1]), "the two justification minimums must agree");
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
  assert.match(page, /rows=\{dismissed\}/, "the dismissed list is rendered, not counted");
  assert.match(page, /rows=\{snoozed\}/, "…and so is the snoozed one");
  assert.match(page, /\{lead\.reason\}/, "the reason has to be rendered, not just carried");
  assert.match(page, /RestoreAttentionButton/, "and there must be a way back");
});

test("the server enforces the reason, not just the dialog", () => {
  // A Server Action is a public endpoint. A client that skipped the form would
  // otherwise write an empty justification — worse than no field at all, because
  // the audit trail would look complete.
  // Sliced to the DISMISS action, because the file now holds three and
  // `indexOf` on the whole thing would compare positions across functions.
  const action = shipped("src/app/actions/attention.ts");
  const body = action.slice(
    action.indexOf("export async function dismissLeadAttention"),
    action.indexOf("export async function restoreLeadAttention"),
  );
  const check = body.indexOf(`attentionReasonError(reason, "dismiss")`);
  const write = body.indexOf("prisma.$transaction(");
  assert.ok(check > 0 && check < write, "validated before anything is written");
  assert.match(body, /if \(invalid\) return \{ ok: false, error: invalid \}/);

  // The SNOOZE action validates both its inputs the same way, and before its own
  // write — a date is as skippable by a crafted client as a reason.
  const snooze = action.slice(
    action.indexOf("export async function snoozeLeadAttention"),
    action.indexOf("export async function dismissLeadAttention"),
  );
  assert.ok(
    snooze.indexOf("snoozeDateError(") < snooze.indexOf("prisma.$transaction("),
    "the date is checked before the write too",
  );

  // The dialog shows the SAME sentences the server would have replied with.
  const dialog = shipped("src/components/SetAsideAttentionButton.tsx");
  assert.match(dialog, /attentionReasonError\(reason, mode\)/);
  assert.match(dialog, /snoozeDateError\(untilDate, new Date\(\)\)/);
});

test("restoring needs no reason, and clears the old one", () => {
  // The asymmetry is deliberate: restoring ADDS work to a queue and needs no
  // justification. Keeping a stale reason on a live row would have it read as
  // current the next time somebody dismissed the deal.
  const action = shipped("src/app/actions/attention.ts");
  const restore = action.slice(action.indexOf("export async function restoreLeadAttention"));
  assert.doesNotMatch(restore, /attentionReasonError/);
  assert.match(restore, /attentionDismissedAt: null/);
  assert.match(restore, /attentionDismissReason: null/);
});

test("BOTH ways off the list exist, and NEITHER is reasonless", () => {
  // Snooze and dismiss are different decisions, and removing snooze to make
  // dismiss accountable was the wrong trade — the commonest real case is "in
  // Italy at the moment, back on the 19th", where nothing is wrong with the deal.
  // Dismissing that is a lie and leaving it shouting is what makes a list stop
  // being read. The fix was to make snooze accountable too, not to delete it.
  const action = shipped("src/app/actions/attention.ts");
  assert.match(action, /export async function snoozeLeadAttention\(/);
  assert.match(action, /export async function dismissLeadAttention\(/);
  assert.match(action, /attentionReasonError\(reason, "snooze"\)/);
  assert.match(action, /attentionReasonError\(reason, "dismiss"\)/);

  // The page offers both on every row.
  const page = shipped("src/app/(app)/leads/attention/page.tsx");
  assert.match(page, /mode="snooze"/);
  assert.match(page, /mode="dismiss"/);
});

test("a read-only viewer is not offered controls they cannot use", () => {
  // The page renders for anyone who may SEE leads, but every set-aside action
  // calls `requireLeadAccess(leadId, "leads.edit")`. Rendering the buttons
  // regardless let a read-only viewer open a dialog, type a reason, submit, and
  // be refused — worse than not offering the button, because the work is wasted
  // and the refusal reads as a fault rather than as a rule.
  const page = shipped("src/app/(app)/leads/attention/page.tsx");
  assert.match(page, /const canEdit = await hasPermission\(user, "leads\.edit"\)/);

  // Every control is behind it — the two set-aside buttons and the restore.
  assert.match(page, /\{canEdit && \(\s*<div[^>]*>\s*<SetAsideAttentionButton/);
  assert.match(page, /\{canEdit && <RestoreAttentionButton/);

  // …and the LISTS are not. Knowing a deal was set aside, and why, is information
  // a read-only viewer is entitled to; only the way back is a write.
  assert.match(page, /rows=\{snoozed\}/);
  assert.match(page, /rows=\{dismissed\}/);
});

test("hiding a control is not a permission", () => {
  // The UI gate is a courtesy. Every action keeps its own check, so a crafted
  // request from a read-only session is still refused — a hidden button proves
  // nothing about what a Server Action will accept.
  const action = shipped("src/app/actions/attention.ts");
  assert.equal(
    (action.match(/requireLeadAccess\(leadId, "leads\.edit"\)/g) ?? []).length,
    3,
    "all three writes re-check, regardless of what the page rendered",
  );
});

test("a snooze must name a date, and a bounded one", () => {
  // An unbounded snooze is a dismiss wearing a date: it silences a deal for
  // practical ever while reading as temporary, which defeats having two tools.
  const now = new Date("2026-08-15T09:00:00Z");
  const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

  assert.ok(snoozeDateError(null, now) != null, "a date is required");
  assert.ok(snoozeDateError(new Date("not a date"), now) != null, "…and must parse");
  assert.ok(snoozeDateError(days(-1), now) != null, "the past is not a snooze");
  assert.ok(snoozeDateError(now, now) != null, "nor is right now");
  assert.equal(snoozeDateError(days(1), now), null, "tomorrow is fine");
  assert.equal(snoozeDateError(days(MAX_SNOOZE_DAYS), now), null, "the boundary passes");
  assert.ok(snoozeDateError(days(MAX_SNOOZE_DAYS + 1), now) != null, "one day past it does not");
});

test("an elapsed snooze brings the deal back on its own", () => {
  // Nothing sweeps the column — the comparison is against `now`, so the deal
  // reappears the moment its date passes.
  const now = new Date("2026-08-15T09:00:00Z");
  assert.equal(isSnoozed(null, now), false);
  assert.equal(isSnoozed(new Date("2026-08-14T09:00:00Z"), now), false, "yesterday is over");
  assert.equal(isSnoozed(new Date("2026-08-19T09:00:00Z"), now), true);
});

test("a dismissed deal does not reappear when an old snooze elapses", () => {
  // A lead can carry both — snoozed in March, dismissed in April. The later,
  // stronger decision is the one that describes where it is, so dismiss is
  // checked FIRST.
  const loader = shipped("src/lib/attention/load.ts");
  const dismissAt = loader.indexOf("isDismissed(lead.attentionDismissedAt)");
  const snoozeAt = loader.indexOf("isSnoozed(lead.attentionSnoozedUntil, now)");
  assert.ok(dismissAt > 0 && snoozeAt > 0, "both must be checked");
  assert.ok(dismissAt < snoozeAt, "dismiss wins, so it is tested first");
});

test("one restore brings a deal back however it left", () => {
  // Asking somebody to notice whether a deal was snoozed or dismissed before they
  // can un-hide it would serve the data model, not the person reading the screen.
  const restore = shipped("src/app/actions/attention.ts");
  const body = restore.slice(restore.indexOf("export async function restoreLeadAttention"));
  assert.match(body, /attentionSnoozedUntil: null/);
  assert.match(body, /attentionDismissedAt: null/);
  assert.match(body, /attentionSnoozeReason: null/);
  assert.match(body, /attentionDismissReason: null/);
});

/* ── the loader's contracts ─────────────────────────────────────────────── */

test("scope comes from the shared helper, with its documented empty-list rule", () => {
  // `[]` must become an impossible match rather than an absent filter — the bug
  // that turns a permission-scoped list into a full one.
  const loader = shipped("src/lib/attention/load.ts");
  assert.match(loader, /getAccessibleLeadIds\(user\)/);
  assert.match(
    loader,
    /if \(accessibleIds !== null && accessibleIds\.length === 0\) return \{ leads: \[\], snoozed: \[\], dismissed: \[\] \}/,
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

test("all three writes are permissioned, scoped, audited and atomic", () => {
  // Snooze, dismiss and restore. The count is the ratchet: a fourth way to change
  // what appears on this list has to come here and say so.
  const action = shipped("src/app/actions/attention.ts");
  assert.equal(
    (action.match(/withActingStaffScope\(/g) ?? []).length,
    3,
    "every standalone Server Action binds its workspace",
  );
  assert.equal(
    (action.match(/requireLeadAccess\(leadId, "leads\.edit"\)/g) ?? []).length,
    3,
    "a read-only viewer must not be able to empty somebody else's queue",
  );
  // A decision nobody can account for is what the reasons exist to prevent, so no
  // write may commit without its audit.
  assert.equal((action.match(/prisma\.\$transaction\(/g) ?? []).length, 3);
  assert.equal((action.match(/logAuditStrict\(/g) ?? []).length, 3);
  for (const entry of ["snoozed", "dismissed", "restored"]) {
    assert.match(action, new RegExp(`action: "lead\\.attention_${entry}"`));
  }
  // The reason is recorded in the audit summary, not only in the column — the
  // column is overwritten the next time the deal is set aside; the audit is not.
  assert.equal(
    (action.match(/reason: “\$\{trimmed\}”/g) ?? []).length,
    2,
    "both set-aside audits quote the reason given",
  );
});

test("the dismiss dialog is not optimistic", () => {
  // The row DISAPPEARS on success. An optimistic removal that then failed would
  // leave somebody believing they had dealt with a deal they had not.
  // Anchored on the EARLY RETURN rather than on exact whitespace: the failure
  // branch has to bail out before anything closes the dialog or hides the row.
  const button = shipped("src/components/SetAsideAttentionButton.tsx");
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
