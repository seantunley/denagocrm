import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #22, activities: every "Done", "Schedule", "Save changes" and "✕" on
// an activity threw on refusal — a full workshop slot, a follow-up with no note,
// completing tomorrow's call today — and staff saw "This page hit an error".
// None of these actions bound the acting workspace either.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const actions = src("src/app/actions/activities.ts");

test("no activity action throws a bare Error or crashes on a missing row", () => {
  assert.doesNotMatch(actions, /throw new Error\(/);
  assert.doesNotMatch(actions, /findUniqueOrThrow\(/);
  assert.doesNotMatch(actions, /if \(!summary\) return;/, "a bare return reads as success");
});

test("form-facing actions return ActionResult; the three own-shape ones map refusals", () => {
  for (const name of ["scheduleActivity", "completeActivity", "cancelActivity", "updateActivity"]) {
    const at = actions.indexOf(`export async function ${name}(`);
    assert.match(actions.slice(at, at + 200), /return asActionResult\(/, name);
  }
  for (const name of ["completeActivityAssess", "rescheduleActivity", "scheduleFollowUp"]) {
    const at = actions.indexOf(`export async function ${name}(`);
    assert.match(actions.slice(at, at + 400), /return asOwnResult\(/, name);
  }
  // asOwnResult binds the workspace and turns only REFUSALS into values.
  assert.match(actions, /return withActingStaffScope\(async \(\) => \{\s*try \{\s*return await body\(\);\s*\} catch \(error\) \{\s*if \(error instanceof ActionRefusal\) return refused\(error\.message\);\s*throw error;/);
});

test("the future-day refusal reaches the person instead of an error page", () => {
  assert.match(actions, /refuse\(futureActivityRefusal\(scheduled\.dueDate\)\)/);
  const nextStep = src("src/components/proactive/NextStep.tsx");
  assert.equal((nextStep.match(/if \(!res \|\| res\.error\) \{/g) ?? []).length, 2);
});

test("every form that posts to these is a SaveForm", () => {
  for (const file of ["src/components/ActivityPanel.tsx", "src/components/LeadTimeline.tsx", "src/app/(app)/activities/page.tsx"]) {
    const s = src(file);
    assert.doesNotMatch(s, /<form[^>]*\baction=\{(scheduleActivity|completeActivity|cancelActivity|updateActivity)/, file);
    assert.doesNotMatch(s, /<form\s+action=\{(completeActivity|cancelActivity|updateActivity)/, file);
  }
});

test("programmatic callers read the returned refusal (it no longer throws)", () => {
  assert.match(src("src/components/CalendarWorkspace.tsx"), /if \(result && typeof result === "object" && "error" in result && result\.error\) \{/);
  // Quick-create must not close and say "scheduled" on a refusal.
  assert.match(src("src/components/QuickCreateDialog.tsx"), /const result = await scheduleQuickActivity\(formData\);\s*if \(result\?\.error\) \{/);
});
