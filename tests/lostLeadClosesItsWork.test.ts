import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

const LEADS = "src/app/actions/leads.ts";
const EXECUTOR = "src/lib/journeyStepExecutor.ts";
const ACTIVITIES = "src/app/actions/activities.ts";

test("stripComments does not credit a call that is only described", () => {
  assert.equal(/foo\(/.test(stripComments("// foo()")), false);
  assert.equal(/foo\(/.test(stripComments("await foo();")), true);
});

/* ── a lost lead takes its planned work with it ──────────────────── */

test("BOTH PATHS THAT LOSE A LEAD CANCEL ITS PLANNED ACTIVITIES", () => {
  /*
   * The agenda, calendar and overdue prompts all select on
   * `status: "planned"` WITHOUT looking at the lead's status, so a binned spam
   * lead left its "call this new lead" rows asking to be done forever.
   *
   * Both paths, because fixing only the one the report came from leaves the
   * automated route quietly broken — and that is the one that runs unattended.
   */
  for (const file of [LEADS, EXECUTOR]) {
    assert.match(
      stripComments(src(file)),
      /cancelPlannedActivitiesForLostLead\(/,
      `${file} must clear the lead's agenda when it loses it`,
    );
  }
});

test("the journey path only cancels when the close actually applied", () => {
  // applyLeadOutcome returns applied:false when the predicate matched nothing
  // (already lost, deleted, another workspace). Cancelling on that would reach
  // across a guard written specifically to stop side effects firing twice.
  const code = stripComments(src(EXECUTOR));
  const guard = code.indexOf("if (!outcome.applied)");
  const call = code.indexOf("cancelPlannedActivitiesForLostLead(");
  assert.ok(guard > 0 && call > 0, "both the guard and the call must exist");
  assert.ok(call > guard, "the cancel must sit AFTER the applied guard returns");
  assert.equal(nearestStepGuard(code, call), "lead_mark_lost", "…and only for the lost step");
});

/**
 * The step type the call is actually guarded by — the LAST `if (step.type ===`
 * before it, rather than whatever happens to sit within N characters.
 *
 * A proximity window scored the referral block's `lead_mark_won` immediately
 * above and failed a correct implementation, which is the same defect as
 * matching a comment: the assertion named one thing and tested another.
 */
function nearestStepGuard(code: string, at: number): string | null {
  const guards = [...code.slice(0, at).matchAll(/if \(step\.type === "([a-z_]+)"/g)];
  return guards.length ? guards[guards.length - 1][1] : null;
}

test("ONLY PLANNED ROWS ARE TOUCHED, AND THEY ARE CANCELLED NOT DELETED", () => {
  /*
   * "done" would inflate completion stats with work nobody did; deleting loses
   * the record that it was ever scheduled. An activity already done or
   * cancelled is settled history and must not be rewritten.
   */
  const code = stripComments(src("src/lib/leadClose.ts"));
  assert.match(code, /status:\s*"planned"/, "the filter must be planned-only");
  assert.match(code, /status:\s*"cancelled"/, "…and the write must be cancelled");
  assert.doesNotMatch(code, /deleteMany|delete\(/, "must not delete the history");
  assert.doesNotMatch(code, /data:\s*\{\s*status:\s*"done"/, "must not mark them done");
});

test("won leads are deliberately NOT swept", () => {
  // A won deal routinely carries real scheduled work — delivery, handover, first
  // service. Sweeping that would destroy live commitments rather than tidy dead
  // ones. If this ever changes it should be a decision, not a symmetry.
  const code = stripComments(src(EXECUTOR));
  const call = code.indexOf("cancelPlannedActivitiesForLostLead(");
  assert.notEqual(nearestStepGuard(code, call), "lead_mark_won");
  // And the sweep must not have been hoisted out of a step guard entirely.
  assert.ok(nearestStepGuard(code, call) !== null, "the sweep must stay behind a step guard");
});

test("lostAt is written, or the lost-leads report is empty forever", () => {
  // reports/page.tsx filters lost leads on `lostAt: { gte: from, lt: to }`, and
  // nothing anywhere set the column.
  assert.match(stripComments(src(LEADS)), /lostAt:\s*new Date\(\)/);
  assert.match(src("src/app/(app)/reports/page.tsx"), /lostAt:\s*\{\s*gte:/);
});

/* ── the next-step dialog outlives the row that opened it ────────── */

test("FINISHING AN ACTIVITY REVALIDATES NOTHING — THE CALLER DECIDES", () => {
  /*
   * `revalidatePath` in a Server Action does not only mark the named path: it
   * invalidates the client Router Cache and the response re-renders the CURRENT
   * tree. finishActivity called revalidateRecordPages unconditionally, so
   * revalidating /leads/:id still refreshed the dashboard, unmounted the agenda
   * row, and took the "What's next?" dialog with it — the exact "pops up for a
   * second then vanishes" that completeActivityAssess's deferral was written to
   * stop. The deferral was one level too high to work.
   */
  const code = stripComments(src(ACTIVITIES));
  const body = code.slice(
    code.indexOf("async function finishActivity("),
    code.indexOf("export async function completeActivity("),
  );
  assert.ok(body.length > 0, "finishActivity must exist");
  assert.doesNotMatch(body, /revalidate/, "finishActivity must not revalidate anything");
});

test("the deferred refresh covers the record pages it skipped", () => {
  const code = stripComments(src(ACTIVITIES));
  // While the dialog is open, neither the views nor the record pages may run.
  const assess = code.slice(code.indexOf("export async function completeActivityAssess("));
  assert.match(assess, /if \(!needsNextStep\) \{[\s\S]*?revalidateActivityViews\(\)/);
  assert.match(assess, /if \(!needsNextStep\) \{[\s\S]*?revalidateRecordPages\(activity\)/);
  // …and the deferred call must then catch up on the lead page.
  const refresh = code.slice(
    code.indexOf("export async function refreshAfterNextStep("),
    code.indexOf("export async function completeActivityAssess("),
  );
  assert.match(refresh, /leadId/, "the deferred refresh must take the lead it skipped");
  assert.match(refresh, /revalidatePath\(`\/leads\/\$\{leadId\}`\)/);
});

test("the client hands the deferred refresh the lead it was holding", () => {
  const ui = stripComments(src("src/components/proactive/NextStep.tsx"));
  const calls = [...ui.matchAll(/refreshAfterNextStep\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 2, "both dialogs must refresh on close");
  for (const arg of calls) {
    assert.match(arg, /nextStep\.leadId/, "…passing the lead, not nothing");
  }
});
