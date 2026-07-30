/**
 * The run state to persist when the BUDGET stops us part-way through a run.
 *
 * Exported so the properties that matter can be asserted directly. Getting this
 * wrong is silent and expensive: an earlier version simply broke out of the step
 * loop, which fell through to the "exceeded MAX_STEPS_PER_TICK" throw and made
 * the catch mark an unexecuted step failed, burn a retry, and permanently fail
 * the journey after three budget stops.
 *
 * Running out of time is NOT a failure:
 *   - status returns to "queued" (the run was claimed as "running"),
 *   - currentStepId is preserved, so the next tick resumes on the same step,
 *   - attempts is ABSENT — untouched, so no retry is consumed and any genuine
 *     earlier failures keep their count,
 *   - lastError is ABSENT — there is no error to report.
 */
export function budgetStopUpdate<TContext>(currentStepId: string | null, context: TContext) {
  return {
    status: "queued" as const,
    currentStepId,
    context,
    // Eligible again immediately; the next tick is the one that resumes it.
    nextRunAt: new Date(),
  };
}
