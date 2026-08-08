import test from "node:test";
import assert from "node:assert/strict";

import { classifyMerged, classifyOpen, classifyDeployment } from "../scripts/check-prs-landed.mjs";

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
