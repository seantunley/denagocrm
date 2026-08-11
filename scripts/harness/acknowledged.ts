/**
 * THE ENFORCED-PASS ALLOWLIST — a shrinking, justified debt ratchet.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * The enforced pass is the pre-flip gate, and it is BLOCKING: the workflow step
 * runs with `continue-on-error: false`, so a failure genuinely fails the run.
 *
 * That is only honest if the gate can actually be satisfied, and today it cannot
 * be. At least one enforced failure is not an application defect and cannot be
 * fixed anywhere in this repository — `TimelinePin` READ needs a DATABASE ROLE
 * change, because the application connects as a `BYPASSRLS` role and therefore
 * no RLS policy ever evaluates (see the entry below). Making the step blocking
 * with no allowlist would paint CI permanently red for a reason no commit here
 * can clear, and a permanently red check is one everybody learns to scroll past.
 * Leaving it advisory would mean it is not a gate at all.
 *
 * So: BLOCKING, with a recorded allowlist. Every failure that is NOT in the list
 * below fails the build. The list is the whole of the exemption, and it is
 * visible, attributed, and counted out loud on every single run.
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
 */
export const ACKNOWLEDGED_ENFORCED_FAILURES: AcknowledgedFailure[] = [];

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
