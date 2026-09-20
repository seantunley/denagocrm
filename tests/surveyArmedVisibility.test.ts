import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isSurveyArmed, surveyDormantReason } from "../src/lib/surveyLifecycle";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/**
 * A survey published in July, left on the `delivery` trigger, emailed a real
 * customer and reminded them 48 hours later. Nothing was broken — it did what
 * it was configured to do. The failure was that no screen said it would: the
 * list printed the trigger for drafts and live surveys alike, so the one that
 * was actually sending looked identical to one that was not.
 */

const ARMED = { status: "published", active: true, trigger: "delivery", deletedAt: null };

/* ── the predicate ─────────────────────────────────────────────────── */

test("ARMED MEANS ALL FOUR CONDITIONS, NOT JUST A TRIGGER", () => {
  assert.equal(isSurveyArmed(ARMED), true);

  // Each condition on its own is enough to stop it sending. A trigger alone —
  // which is all the old list showed — proves nothing.
  assert.equal(isSurveyArmed({ ...ARMED, trigger: null }), false, "no trigger");
  assert.equal(isSurveyArmed({ ...ARMED, status: "draft" }), false, "not published");
  assert.equal(isSurveyArmed({ ...ARMED, status: "approved" }), false, "approved is not published");
  assert.equal(isSurveyArmed({ ...ARMED, active: false }), false, "deactivated");
  assert.equal(isSurveyArmed({ ...ARMED, deletedAt: new Date() }), false, "deleted");
});

test("THE PREDICATE MATCHES THE QUERY THE AUTOMATION ACTUALLY RUNS", () => {
  /*
   * The badge is only worth anything if it agrees with the code that sends. If
   * governedSurveyRuntime's WHERE clause gains or loses a condition, this test
   * is the thing that says the screens now lie.
   */
  const runtime = src("src/lib/governedSurveyRuntime.ts");
  const where = runtime.slice(runtime.indexOf('"trigger" = '), runtime.indexOf('"trigger" = ') + 260);

  for (const condition of [
    /"trigger" = /,
    /"status" = 'published'/,
    /"active" = true/,
    /"deletedAt" IS NULL/,
  ]) {
    assert.match(where, condition, `the runtime still gates on ${condition}`);
  }

  const predicate = stripComments(src("src/lib/surveyLifecycle.ts"));
  const body = predicate.slice(predicate.indexOf("export function isSurveyArmed"));
  assert.match(body, /survey\.trigger/);
  assert.match(body, /status === "published"/);
  assert.match(body, /active === true/);
  assert.match(body, /deletedAt/);
});

/* ── configured is not the same as live ────────────────────────────── */

test("A DORMANT TRIGGER SAYS WHY, INSTEAD OF LOOKING LIVE", () => {
  assert.equal(surveyDormantReason(ARMED), null, "armed needs no explanation");
  assert.equal(surveyDormantReason({ ...ARMED, trigger: null }), null, "no trigger, nothing to explain");

  assert.equal(surveyDormantReason({ ...ARMED, active: false }), "deactivated");
  assert.match(surveyDormantReason({ ...ARMED, status: "draft" })!, /not published/);
  assert.match(
    surveyDormantReason({ ...ARMED, status: "changes_requested" })!,
    /changes requested/,
    "the status is spelled out in words, not snake_case",
  );
  assert.equal(surveyDormantReason({ ...ARMED, deletedAt: new Date() }), "deleted");
});

/* ── the screens ───────────────────────────────────────────────────── */

test("THE SURVEYS LIST WARNS BEFORE A CUSTOMER DOES", () => {
  const page = stripComments(src("src/app/(app)/surveys/page.tsx"));

  // Anchored on the CALL and the JSX, not the import: `/FeedbackBanner/` alone
  // matches the import line, so deleting the banner from the page left this
  // test green. Every assertion here has to name something that only exists
  // when the feature is actually rendered.
  assert.match(page, /isSurveyArmed\)/, "the list filters with the real predicate");
  assert.match(page, /<FeedbackBanner/, "and says so at the top of the page, not only per row");
  assert.match(page, /armed\.length > 0 &&/, "the banner is conditional on something being armed");
  assert.match(page, /isSurveyArmed\(s\) &&/, "and the row carries its own badge");
  assert.match(page, /surveyDormantReason\(s\)/, "a configured-but-dormant trigger is labelled as such");

  // The hero stat used to count `active`, which is not what makes a survey
  // send: a survey can be active and unpublished.
  assert.ok(
    !/surveys\.filter\(\(survey\) => survey\.active\)\.length/.test(page),
    "the headline stat no longer counts the flag that does not decide sending",
  );
  assert.match(page, /auto-sending/, "it counts what actually auto-sends");
});

test("THE EDITOR NO LONGER CLAIMS A DRAFT SENDS AUTOMATICALLY", () => {
  const page = stripComments(src("src/app/(app)/surveys/[id]/page.tsx"));

  // The old note was printed for any survey with a trigger configured.
  assert.ok(
    !/survey\.trigger\s*\?\s*AUTO_NOTE\[survey\.trigger\]/.test(page),
    "the note is no longer unconditional on the trigger alone",
  );
  assert.match(page, /surveyDormantReason/, "it distinguishes set-up from sending");
});

test("THE NOTE READS DIFFERENTLY WHEN IT IS LIVE", () => {
  /*
   * Both states must be reachable and must not read the same — the whole
   * failure was two different situations rendering identically.
   */
  const page = src("src/app/(app)/surveys/[id]/page.tsx");
  const fn = page.slice(page.indexOf("function autoSendNote"), page.indexOf("export default"));

  assert.match(fn, /LIVE/, "the armed case is unmistakable");
  assert.match(fn, /not sending/, "the dormant case says it is not sending");
  assert.ok(
    fn.indexOf("LIVE") !== fn.indexOf("not sending"),
    "they are genuinely different strings",
  );
});
