/**
 * Control flow, raised rather than returned.
 *
 * Raising beats threading a status flag back through every caller. We threaded
 * a status union, and it had already started lying: `StepResult.nextStepId`
 * meant THREE things on one
 * field — absent said "follow the step's own nextStepId", `null` said "there is
 * no successor, end the run", and a string said "jump here". The `stop` step
 * used the `null` spelling, so "the author asked to stop" and "this branch
 * happens to have no successor" were literally indistinguishable in the trace.
 *
 * Nesting is what made that untenable. A `stop` inside the third iteration of a
 * `repeat` inside a `choose` has to unwind three frames of cursor state; a
 * return value has to be checked and re-propagated at every one of those levels,
 * and the level that forgets is a silent bug. An exception unwinds them for
 * free.
 *
 * A `wait` is deliberately NOT in here. A wait is a PARK, not an unwind: the run
 * keeps its cursor, goes back to the queue with a future `nextRunAt`, and is
 * resumed — possibly days later, by a different process. Turning that into an
 * exception would throw away the very state that makes it resumable.
 */

/** Base class, so the runner can tell deliberate control flow from a fault. */
export abstract class JourneyControlFlow extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The author asked to stop.
 *
 * A normal, successful end: the run is marked completed, no retry, no error.
 */
export class StopJourney extends JourneyControlFlow {}

/**
 * A bare `condition` step inside a sequence did not pass.
 *
 * Also a normal end — the journey simply does not apply to this record — but a
 * distinct one, because "stopped because the author said so" and "stopped
 * because a filter did not match" are the two answers a trace reader is trying
 * to tell apart.
 */
export class ConditionFailed extends JourneyControlFlow {
  constructor(message = "Condition did not match") {
    super(message);
  }
}

/**
 * Give up on this run and do NOT retry it.
 *
 * The distinction from an ordinary thrown Error is the retry: an ordinary error
 * (an SMS provider 503) is worth three attempts, whereas everything that raises
 * this — a repeat that will not terminate, a run past its lifetime step budget,
 * a cursor that no longer matches its definition — is deterministic. Retrying it
 * three times only burns the budget three times and fails anyway.
 */
export class AbortJourney extends JourneyControlFlow {}

/** True for the exceptions above, false for a genuine fault. */
export function isControlFlow(error: unknown): error is JourneyControlFlow {
  return error instanceof JourneyControlFlow;
}
