/**
 * THE ENFORCED-PASS ALLOWLIST — a shrinking, justified debt ratchet.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * The enforced pass is the pre-flip gate, and it is BLOCKING: the workflow step
 * runs with `continue-on-error: false`, so a failure genuinely fails the run.
 *
 * That is only honest if the gate can actually be satisfied. For most of this
 * work it could not be: one enforced failure was not an application defect and
 * could not be fixed anywhere in this repository — `TimelinePin` READ needed a
 * DATABASE ROLE change, because the harness (like production) connected as a
 * role with the BYPASSRLS attribute and therefore no RLS policy ever evaluated.
 * Making the step blocking with no allowlist would have painted CI permanently
 * red for a reason no commit here could clear, and a permanently red check is
 * one everybody learns to scroll past. Leaving it advisory would have meant it
 * was not a gate at all.
 *
 * So: BLOCKING, with a recorded allowlist. Every failure that is NOT in the list
 * below fails the build. The list is the whole of the exemption, and it is
 * visible, attributed, and counted out loud on every single run.
 *
 * THE LIST IS NOW EMPTY — the harness connects as a NOSUPERUSER NOBYPASSRLS role
 * and that last entry became provably false. The machinery stays exactly as it
 * is. It was not scaffolding for one known problem; it is what stops the NEXT
 * one arriving as a check that quietly went red.
 *
 * ── THIS IS NOT A SUBSTITUTE FOR FIXING THEM ─────────────────────────────────
 *
 * THE ALLOWLIST MUST REACH ZERO BEFORE `TENANT_ENFORCEMENT` IS SWITCHED ON
 * ANYWHERE. Every entry is a statement that flipping enforcement today would
 * leak or lose data in that exact way. An entry is a deadline, not a dispensation
 * — the run prints the count in the RESULT block precisely so that a non-zero
 * allowlist can never be read as "the isolation gate is green".
 *
 * ── WHY IT CANNOT ROT ────────────────────────────────────────────────────────
 *
 * Modelled on `ACKNOWLEDGED_DRIFT` in scripts/apply-migrations.mjs, which pairs
 * an acknowledgement list with a staleness check for the same reason: an
 * allowlist nobody prunes is how the next real finding gets hidden.
 *
 * The list is squeezed from both sides, so it is physically unable to grow
 * silently:
 *
 *   GROWING   a failure whose key is not in the list is UNACKNOWLEDGED and fails
 *             the build. Adding one means editing this file, in a diff, with a
 *             `why` and a `fix` — never by a check quietly going red.
 *
 *   ROTTING   an entry that does not correspond to a currently-FAILING check is
 *             STALE and also fails the build. One rule, no exceptions: if the
 *             check now passes, the entry is a lie and must be deleted; if the
 *             check has vanished, the entry names nothing; if the check has
 *             become a `skip`, the entry is guarding something nobody is
 *             measuring any more, which is the most dangerous of the three
 *             because it looks like coverage.
 *
 * That second rule is what stops the easy dodge. Without it, the way to make
 * this gate green is to rename or disable the probe rather than fix the defect,
 * and nothing would notice.
 *
 * ── HOW TO ADD AN ENTRY ──────────────────────────────────────────────────────
 *
 * You should be reluctant. An entry needs all five fields, and `why` and `fix`
 * are not decorative — `why` must say what the defect actually is, and `fix`
 * must say WHERE THE REAL FIX LIVES, so that "when can this be deleted?" has a
 * checkable answer instead of being institutional memory.
 *
 * `model`, `check` and `name` must match the CheckResult exactly. They are
 * matched as a triple, not by substring, so an entry cannot accidentally cover
 * a check it was not written for.
 */
import type { CheckResult } from "./engine";

export type AcknowledgedFailure = {
  /** Must match CheckResult.model exactly. */
  model: string;
  /** Must match CheckResult.check exactly. */
  check: CheckResult["check"];
  /** Must match CheckResult.name exactly. */
  name: string;
  /** What the defect actually is. Not a restatement of the check name. */
  why: string;
  /** WHERE THE REAL FIX LIVES. A branch, PR, doc or migration — something checkable. */
  fix: string;
};

/**
 * ⚠ THIS LIST MUST REACH ZERO BEFORE TENANT_ENFORCEMENT IS FLIPPED. ⚠
 *
 * Every entry is a known way in which enforcement would still leak or lose data.
 * Delete entries as the fixes land; never add one to make a run green.
 *
 * ── STATE OF PLAY, 2026-08-11: 0 entries ─────────────────────────────────────
 *
 * The ratchet reached zero. This list stood at ELEVEN on 2026-08-11 morning —
 * ten real application defects with fixes in flight, plus the database-role
 * problem. All ten application fixes merged to main and every one of those
 * checks passes in the enforced run:
 *
 *   5  SalesPipeline OWN/READ/UPDATE/DELETE/LIST → PR #457   MERGED — now passing
 *   2  SalesPipeline UNIQUE ×2                   → PR #469   MERGED — now passing
 *   2  Quote OWN, JobCard OWN                    → PR #459   MERGED — now passing
 *   1  TimelinePin OWN                           → PR #475   MERGED — now passing
 *
 * THE ELEVENTH WAS THE ONE THAT WAS NEVER A CODE PROBLEM, and it is now gone
 * too. `TimelinePin [READ]` was the BYPASSRLS database role: `getTimelinePins`
 * is `prisma.$queryRaw`, a Prisma extension cannot rewrite raw SQL, and the only
 * remaining boundary was an RLS policy that no role was ever subject to. It was
 * unfixable by any commit in this repository — and it was ALSO unfixable by the
 * harness, which connected as the scratch server's bootstrap SUPERUSER and so
 * reproduced production's exemption exactly.
 *
 * The harness now connects as a NOSUPERUSER NOBYPASSRLS role
 * (scripts/harness/restrictedRole.ts), created by running the shipped
 * prisma/rls/app-role.sql — the same file the production cutover runs. Under
 * that role the policy evaluates, and the check flipped from fail to pass with
 * NO application change, which is precisely the proof this entry demanded:
 *
 *   before (owner/superuser)     enforced: 48 passed, 1 failed, 25 not covered
 *   after  (restricted role)     enforced: 49 passed, 0 failed, 25 not covered
 *
 * ⚠ AN EMPTY LIST IS NOT A CUTOVER. What is proven is that the policies, the
 * grants and the application's SET LOCAL are correct under a non-bypassing role,
 * on a database built from this repository's migrations. PRODUCTION STILL
 * CONNECTS AS `neondb_owner`. Until DATABASE_URL is repointed there, every policy
 * in production remains inert regardless of what this file says — the gate being
 * green is a statement about the code, and the cutover is a statement about the
 * environment. docs/RLS-ROLE-CUTOVER.md is the second one, and it is a runbook
 * somebody has to execute.
 */
export const ACKNOWLEDGED_ENFORCED_FAILURES: AcknowledgedFailure[] = [
  /* Empty, and the two functions below are what keep it honest: a new failure
   * with no entry fails the build (it cannot arrive quietly), and an entry whose
   * check is not currently failing ALSO fails the build (it cannot outlive what
   * it exempted). Adding one back means writing down what the defect is and
   * where the real fix lives, in a diff a reviewer can see. */
];

/** The identity of a check. Same shape the run report uses to line the passes up. */
export function acknowledgementKey(entry: {
  model: string;
  check: string;
  name: string;
}): string {
  return `${entry.model}::${entry.check}::${entry.name}`;
}

/**
 * Enforced failures nobody has recorded a reason for.
 *
 * These fail the build. This is the direction that matters: a NEW way to break
 * tenant isolation cannot arrive quietly, because the only way to stop it
 * failing the run is to write down what it is and where it gets fixed.
 */
export function unacknowledgedFailures(
  enforced: readonly CheckResult[],
  acknowledged: readonly AcknowledgedFailure[] = ACKNOWLEDGED_ENFORCED_FAILURES,
): CheckResult[] {
  const known = new Set(acknowledged.map(acknowledgementKey));
  return enforced.filter((r) => r.verdict === "fail" && !known.has(acknowledgementKey(r)));
}

export type StaleAcknowledgement = {
  entry: AcknowledgedFailure;
  reason: string;
};

/**
 * Acknowledgements that no longer describe a currently-failing check.
 *
 * THE RULE IS SINGULAR: an entry is valid only while the check it names is
 * actually FAILING. Anything else is stale and fails the build.
 *
 *   passing   the defect is fixed — the entry now claims something untrue, and
 *             leaving it there re-exempts the check the moment it regresses.
 *   absent    renamed or deleted. The entry guards nothing, and the check it was
 *             written for may well be failing again under a different name.
 *   skipped   the probe stopped measuring. This is the one worth being strict
 *             about: it is how an exemption outlives the thing it exempted, and
 *             it reads exactly like coverage from the outside.
 */
export function staleAcknowledgements(
  enforced: readonly CheckResult[],
  acknowledged: readonly AcknowledgedFailure[] = ACKNOWLEDGED_ENFORCED_FAILURES,
): StaleAcknowledgement[] {
  const byKey = new Map(enforced.map((r) => [acknowledgementKey(r), r]));
  const stale: StaleAcknowledgement[] = [];
  for (const entry of acknowledged) {
    const result = byKey.get(acknowledgementKey(entry));
    if (!result) {
      stale.push({
        entry,
        reason:
          "no such check ran — it was renamed or removed. Delete this entry, and check that " +
          "what it described is not now failing under a different name.",
      });
    } else if (result.verdict === "pass") {
      stale.push({
        entry,
        reason: "THIS NOW PASSES — the fix landed. Delete this entry so it can never be re-exempted.",
      });
    } else if (result.verdict === "skip") {
      stale.push({
        entry,
        reason:
          `the check is being SKIPPED, not failing (${result.detail || "no detail"}). Nothing is ` +
          "measuring this any more, so the exemption is guarding a hole. Restore the probe, or " +
          "delete the entry if the check is genuinely gone.",
      });
    }
  }
  return stale;
}

/** Entries that are doing their job right now: recorded, and still failing. */
export function activeAcknowledgements(
  enforced: readonly CheckResult[],
  acknowledged: readonly AcknowledgedFailure[] = ACKNOWLEDGED_ENFORCED_FAILURES,
): AcknowledgedFailure[] {
  const failing = new Set(
    enforced.filter((r) => r.verdict === "fail").map(acknowledgementKey),
  );
  return acknowledged.filter((entry) => failing.has(acknowledgementKey(entry)));
}
