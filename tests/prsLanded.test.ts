import test from "node:test";
import assert from "node:assert/strict";

import { classifyMerged, classifyOpen, classifyDeployment, RECOVERED_BY } from "../scripts/check-prs-landed.mjs";

/**
 * The check that would have caught 2026-08-07.
 *
 * Thirty-four pull requests were merged that afternoon and fifteen never reached
 * production. Nothing failed: they were stacked PRs whose base was the branch
 * below them, so each merged into its parent exactly as instructed. GitHub said
 * MERGED, CI was green, and the features were not on main. It surfaced hours
 * later as "where is the dashboard editor?".
 *
 * GitHub has no opinion about this — by its lights every merge succeeded. Only
 * git can answer it, by asking whether the merge commit is an ancestor of the
 * trunk. These tests pin that rule, using the real shapes from that day.
 */

test("a pull request merged into main has landed", () => {
  const pr = { number: 336, title: "Per-tenant branding", baseRefName: "main", headRefOid: "4400b59e" };
  assert.equal(classifyMerged(pr, true).status, "landed");
});

test("a pull request merged into its parent branch is STRANDED", () => {
  // #325 verbatim: merged, and its base was feat/dashboard-config.
  const pr = {
    number: 325,
    title: "feat(dashboard): the editor",
    baseRefName: "feat/dashboard-config",
    headRefOid: "6609cbb3",
  };
  const result = classifyMerged(pr, false);
  assert.equal(result.status, "stranded");
  assert.match(String(result.reason), /merged into "feat\/dashboard-config", not main/);
  assert.match(String(result.reason), /ships only when its base does/);
});

test("the diagnosis names the base, because that is always the cause", () => {
  // A report saying only "not on main" sends someone hunting through history.
  // Naming the base makes the fix obvious: merge the branch that received it.
  const result = classifyMerged(
    { number: 351, title: "Escape tenant email HTML", baseRefName: "feat/tenant-public-origin", headRefOid: "559a128e" },
    false,
  );
  assert.match(String(result.reason), /feat\/tenant-public-origin/);
});

test("a merge commit missing from main for any OTHER reason is still reported", () => {
  // Base was main and it still is not there — a rewritten or reset history.
  // Different cause, same consequence, so it must not be silently excused.
  const result = classifyMerged(
    { number: 999, title: "Something", baseRefName: "main", headRefOid: "deadbeef" },
    false,
  );
  assert.equal(result.status, "stranded");
  assert.match(String(result.reason), /not an ancestor of main/);
});

test("a merge with no recorded commit is reported, not assumed fine", () => {
  // Squash and rebase strategies can leave no traceable merge commit. "Cannot
  // tell" is not "is fine", and quietly counting it as landed is exactly the
  // habit that caused the incident.
  const result = classifyMerged({ number: 42, title: "Squashed", baseRefName: "main", headRefOid: null }, true);
  assert.equal(result.status, "unverifiable");
});

test("an open pull request that does not target main is flagged before it bites", () => {
  const flagged = classifyOpen({ number: 348, title: "Platform 2FA", baseRefName: "feat/tenant-public-origin" });
  assert.ok(flagged);
  assert.equal(flagged.base, "feat/tenant-public-origin");

  // Targeting main is the normal case and must stay quiet, or the warning gets
  // ignored and stops working.
  assert.equal(classifyOpen({ number: 1, title: "Normal", baseRefName: "main" }), null);
});

/**
 * The twin failure, same day: every production deploy failed for three hours
 * while CI stayed green. Migrations run inside the Vercel BUILD command, so a
 * migration that fails on real data fails the whole deployment — and CI applies
 * migrations to an EMPTY database, where that row cannot exist. "CI is green"
 * was reported as "it shipped" for three hours.
 */

test("a failed production deployment is a failure", () => {
  for (const state of ["failure", "error"] as const) {
    const verdict = classifyDeployment(state);
    assert.equal(verdict.ok, false, `${state} must not pass`);
    assert.match(String(verdict.reason), /most recent production deployment/);
  }
});

test("a successful deployment passes", () => {
  assert.equal(classifyDeployment("success").ok, true);
});

test("a deployment still running is NOT judged", () => {
  // Failing on an in-flight deploy would make this racy, and a racy guard is one
  // people disable. Silence here is deliberate.
  for (const state of ["in_progress", "queued", "pending", undefined]) {
    assert.equal(classifyDeployment(state).ok, true, `${state} must not fail the check`);
    assert.match(classifyDeployment(state).reason, /not judged/);
  }
});

/**
 * RECOVERY RECORDS — the one way a stranded pull request may stop being
 * reported, and the ways it may not.
 *
 * Recovering a stranded stack means re-landing its work from a fresh branch.
 * Under a squash workflow that is a new commit, so the original PR's head never
 * becomes an ancestor of the trunk and neither does its own merge commit — the
 * two things this file checks. The work is on main and the bookkeeping cannot
 * show it, so without a record the guard reports those PRs as lost forever. A
 * check that cries wolf is one people switch off.
 *
 * The danger is obvious, so it is pinned here: a record must not be able to
 * excuse work that is genuinely missing.
 */
test("a recorded recovery counts only when the replacement itself landed", () => {
  const pr = { number: 478, title: "Gate the stage reorder", baseRefName: "fix/stage-lookup-inside-the-gate", headRefOid: "abc" };
  const result = classifyMerged(pr, false, true);
  assert.equal(result.status, "recovered");
  assert.equal(result.recoveredBy, 498, "the report must name where the work actually went");
});

test("a recovery that has NOT landed leaves the original stranded", () => {
  // THE ANTI-WAIVER. An entry redirects the question; it never answers it. If
  // the replacement is reverted or was never merged, the original is still
  // missing and must still be reported.
  const pr = { number: 478, title: "Gate the stage reorder", baseRefName: "fix/stage-lookup-inside-the-gate", headRefOid: "abc" };
  const result = classifyMerged(pr, false, false);
  assert.equal(result.status, "stranded");
  // Asserted present before matching, rather than cast: `reason` is genuinely
  // optional on the returned shape (a landed result has none), and a cast would
  // hide a future refactor that stopped setting it here.
  assert.ok(result.reason, "a stranded result must explain itself");
  assert.match(result.reason, /#498 has not reached/, "the reason must say the replacement is the missing part");
});

test("a recovery record cannot rescue a pull request that has no record", () => {
  // Only the enumerated numbers are redirected. Everything else is unaffected,
  // whatever the caller passes for the recovery argument.
  const pr = { number: 999, title: "Unrelated", baseRefName: "some/branch", headRefOid: "abc" };
  assert.equal(classifyMerged(pr, false, true).status, "stranded");
  assert.equal(classifyMerged(pr, false, undefined).status, "stranded");
});

test("a landed pull request is never reclassified by a recovery record", () => {
  // Landing under its own number always wins, so a stale record cannot mask a
  // PR that shipped normally.
  const pr = { number: 478, title: "Gate the stage reorder", baseRefName: "main", headRefOid: "abc" };
  assert.equal(classifyMerged(pr, true, false).status, "landed");
});

test("the recovery table stays small and self-describing", () => {
  // A growing table is the smell this guard exists to catch: it would mean
  // stranding PRs routinely and recording it rather than fixing the merges.
  // Deliberately tight, so adding one is a decision somebody has to argue for.
  assert.ok(
    Object.keys(RECOVERED_BY).length <= 5,
    `${Object.keys(RECOVERED_BY).length} recovery records — if this is growing, fix the merge process, not the guard`,
  );
  for (const [stranded, recovery] of Object.entries(RECOVERED_BY)) {
    assert.ok(Number(recovery) > Number(stranded), `#${recovery} must be NEWER than the #${stranded} it replaces`);
  }
});
