import { ConditionFailed, StopJourney, AbortJourney } from "./journeyControlFlow";
import {
  evaluateConditions,
  explainConditions,
  parseConditionGroup,
  type JourneyStep,
} from "./journeyTypes";

/**
 * The two step types whose only job is to DECIDE something.
 *
 * Split out of journeyStepExecutor because that module reaches the database, the
 * email provider, the SMS provider and push — it cannot be imported at all
 * outside a server request (`server-only`, via tenantActor). These two decisions
 * are pure, and they are the ones most worth testing directly: "which clause
 * decided it" and "what a failing condition means where it stands" are exactly
 * the questions the trace exists to answer.
 */

/** Structurally a StepResult; typed here so this module stays dependency-free. */
export type ControlStepOutcome = {
  status: "completed";
  note: string;
  branch?: { stepId: string | null };
  output: Record<string, unknown>;
};

/**
 * Where a TOP-LEVEL step goes next.
 *
 * `branch` present — even holding null — is an EXPLICIT decision by the step;
 * absent means "fall through to the step's own nextStepId". Those two used to be
 * `null` and `undefined` on a single `nextStepId` field, which is how the `stop`
 * step and a branch that merely ran out of successors became the same value.
 */
export function resolveTopLevelNext(
  step: JourneyStep,
  result: { branch?: { stepId: string | null } },
): string | null {
  return result.branch ? result.branch.stepId : step.nextStepId ?? null;
}

/**
 * A `condition` step.
 *
 * `inSequence` changes what failing MEANS:
 *
 *  - top level: a two-way branch. trueStepId / falseStepId / nextStepId, as it
 *    has always been, so existing journeys are untouched.
 *  - inside a choose/repeat sequence: a GATE. There is nowhere to branch to — a
 *    sequence runs in order and has no ids to jump to, which is why the parser
 *    rejects trueStepId there — so failing raises ConditionFailed and unwinds
 *    the run. Use `choose` when you want an else.
 */
export function conditionStepOutcome(
  step: JourneyStep,
  context: Record<string, unknown>,
  inSequence: boolean,
): ControlStepOutcome {
  const condition = parseConditionGroup(step.config.condition);
  const passed = evaluateConditions(condition, context);
  // WHICH clause decided it, not just the verdict. "Condition did not match"
  // sends someone re-reading every clause by hand against a lead that has since
  // changed; the per-clause result is the answer they were going to reconstruct.
  const clauses = explainConditions(condition, context);

  if (inSequence) {
    if (!passed) throw new ConditionFailed("Condition did not match");
    return { status: "completed", note: "Condition matched", output: { passed, clauses } };
  }

  const configured = passed ? step.config.trueStepId : step.config.falseStepId;
  const taken = typeof configured === "string" && configured ? configured : step.nextStepId ?? null;
  return {
    status: "completed",
    note: passed ? "Condition matched" : "Condition did not match",
    branch: { stepId: taken },
    output: {
      passed,
      // `branchTaken` names the step, so a trace reader can follow the path
      // without re-deriving it from trueStepId/falseStepId themselves.
      branchTaken: taken,
      branch: passed ? "true" : "false",
      clauses,
    },
  };
}

/**
 * A `stop` step. ALWAYS throws — the return type says so.
 *
 * It used to return `nextStepId: null`, which was the same value a branch with
 * no successor produced, so nothing downstream could tell "the author stopped
 * this" from "it ran out of steps". Unwinding matters too now: a stop three
 * sequences deep has to leave all three, and an exception does that without
 * every level having to re-propagate a flag.
 */
export function stopStepOutcome(step: JourneyStep): never {
  const reason = typeof step.config.reason === "string" && step.config.reason.trim()
    ? step.config.reason.trim()
    : "Journey stopped";
  // `error: true` on a stop step ends the run as a FAILURE rather than a normal
  // finish. It marks the run failed WITHOUT retrying — a declared stop is
  // deterministic,
  // so three attempts would fail three times.
  if (step.config.error === true) throw new AbortJourney(reason);
  throw new StopJourney(reason);
}
