import type { JourneyCursor, JourneyWaitState } from "./journeyCursor";
import { JOURNEY_WAIT_STEP_TYPES } from "./journeyTypes";

/**
 * `wait_for_trigger`: park a run until a named event arrives for this entity.
 *
 * ── The decision: the waiter POLLS; the event processor does not push ───────
 *
 * The obvious design is push — `processJourneyEvents` already walks every
 * pending event, so it could look for runs parked on a matching wait and set
 * `nextRunAt = now`. It was rejected, on three specific failures rather than
 * taste. A waiting run is a different thing from an enrolment, and it has to
 * survive all three of these:
 *
 *   1. AN EVENT ARRIVING BETWEEN THE PARK AND THE COMMIT. The runner decides to
 *      wait at T0 and writes the row at T0+ε. A pusher scanning at T0+ε/2 finds
 *      no parked run — the row is not there yet — marks the event processed and
 *      moves on. The run then sits until its timeout with the event it was
 *      waiting for already in the table. Closing that needs the park and the
 *      event scan inside one transaction, and they are two different crons.
 *      Polling has no such window: `since` is captured at T0, BEFORE the write,
 *      so an event at T0+ε/2 is `>= since` and the next poll finds it.
 *
 *   2. TWO EVENTS IN THE SAME TICK. A pusher would nudge the same run twice and
 *      the second nudge is either a no-op or a double wake, depending on
 *      ordering nobody controls. The poll asks one ordered question — earliest
 *      matching event at or after `since` — and gets one answer. A wait resumes
 *      on the FIRST trigger that fires and then stops listening.
 *
 *   3. THE RUN BEING PURGED. Push means the event processor holds a reference to
 *      a run row, which is the `blockedByRunId` dangling-id problem again. With
 *      polling the waiter is the only actor: a purged run simply stops asking,
 *      and there is nothing left pointing at it.
 *
 * What polling costs is latency and one indexed query per waiting run per tick.
 * The latency is not actually worse: `processJourneyRuns` only picks up runs
 * whose `nextRunAt` has passed, so even a pushed wake would not run before the
 * next engine tick. The query is bounded by JourneyEvent's
 * (entityType, entityId, type, createdAt) index and by there being at most one
 * armed wait per run.
 *
 * ── Resuming at the right FRAME ─────────────────────────────────────────────
 *
 * A wake must land on the exact frame position, not a top-level step id. That is
 * not solved here by re-deriving anything: the runner never advances the cursor
 * while a wait is armed, exactly as it does not advance a send that quiet hours
 * held (`StepResult.retryStep`). The frames are still on the cursor, untouched,
 * so `resolveCursor` walks straight back to the same step. The wait's own
 * identity is the trace PATH — see JourneyWaitState — so the same step in
 * iteration 2 of a repeat is a genuinely different wait from iteration 0's.
 *
 * ── `wait_for_condition` shares all of this, and one thing differs ──────────
 *
 * The park, the watermark, the deadline, the poll cadence and `decideWait` are
 * the same; only the question asked on each poll changes. There the poll is not
 * a choice between designs — a condition over a lead's own columns has nothing
 * to push. Nobody writes a row when a lead's status changes to the value some
 * parked run happens to be watching for, and adding one would be a trigger for
 * every field of every record.
 *
 * WHAT DIFFERS IS OBSERVABILITY, and it is the thing to hold on to. A
 * `wait_for_trigger` finds a ROW, and the row carries the instant it happened —
 * which is why a cron that limps in ninety minutes late can still resume a run
 * on an event that genuinely arrived inside the window. A polled condition has
 * no such timestamp: all it ever learns is "true, now". So "it became true
 * inside the window" is not knowable, and only an observation MADE inside the
 * window counts. `decideWait` is handed `now` in place of an event time and
 * applies the identical rule.
 *
 * The consequence, stated plainly rather than discovered later: the effective
 * resolution of a polled condition is one poll interval. Something that becomes
 * true in the final interval before the deadline is reported as a timeout, and
 * that is inherent to polling — not a boundary the runner may reinterpret,
 * because reinterpreting it is precisely how an outcome starts depending on
 * when the cron happened to run.
 */

/**
 * How often an armed wait re-checks. One minute, deliberately shorter than the
 * cron cadence: the poll is not the clock, the engine tick is. This only ensures
 * a wait never sleeps LONGER than a tick, so the wake latency is the cron's and
 * not an interval invented here.
 */
export const WAIT_POLL_INTERVAL_MS = 60_000;

/**
 * The wait already armed AT THIS POSITION, or null.
 *
 * Three things hang off this one comparison, which is why it is a named
 * function rather than an inline condition in the runner:
 *
 *   - a POLL is told apart from a first arrival, so the lifetime step budget is
 *     charged once for the wait rather than once per engine tick;
 *   - the step log is not re-opened on every poll, so the trace reports the
 *     whole wait instead of the last sixty seconds of it;
 *   - and each iteration of an enclosing `repeat` gets its OWN wait.
 *
 * That last one is the trap. Matching on the STEP ID would make iteration 1
 * inherit iteration 0's watermark and wake instantly on the event that already
 * resolved iteration 0 — a "chase them twice" journey would fire both chases the
 * moment the first reply landed. `path` carries the iteration, exactly as the
 * step log's key does.
 *
 * A wait attached to any other position is stale — a hand-edited cursor, or a
 * definition that changed under a parked run — and the caller drops it.
 *
 * The step-type check is a SET, not a comparison against one name. The cursor
 * carries exactly one armed wait, because a run is at exactly one position; a
 * second waiting step type that this function did not recognise would find its
 * own wait "stale", drop it, and re-arm from scratch on every single poll — a
 * wait that never expires and never fires, with a fresh watermark each minute.
 */
const WAIT_STEP_TYPES = new Set<string>(JOURNEY_WAIT_STEP_TYPES);

export function armedWaitFor(
  cursor: JourneyCursor,
  step: { type: string },
  path: string,
): JourneyWaitState | null {
  if (!cursor.wait) return null;
  if (!WAIT_STEP_TYPES.has(step.type)) return null;
  return cursor.wait.path === path ? cursor.wait : null;
}

/**
 * Shared by both waits: the state is the same three fields either way, because
 * "where am I, since when, and until when" is the whole of a park. What differs
 * is only the question asked on each poll.
 */
export function armWaitState(
  path: string,
  config: { timeoutMinutes: number },
  now: Date,
): JourneyWaitState {
  return {
    path,
    since: now.toISOString(),
    until: new Date(now.getTime() + config.timeoutMinutes * 60_000).toISOString(),
  };
}

/** When the next poll should happen: never past the deadline it is racing. */
export function waitPollAt(wait: JourneyWaitState, now: Date): Date {
  const until = Date.parse(wait.until);
  const next = now.getTime() + WAIT_POLL_INTERVAL_MS;
  return new Date(Math.min(next, until));
}

export type WaitDecision =
  | { kind: "woken" }
  | { kind: "timed_out" }
  | { kind: "keep_waiting"; nextRunAt: Date };

/**
 * Is `at` inside the window this wait was armed for?
 *
 * HALF-OPEN: `[since, until)`.
 *
 * `since` is inclusive because an event written in the same millisecond the
 * wait armed arrived while we were listening, and losing it would be silent.
 *
 * `until` is EXCLUSIVE because it is already the first instant of "timed out" —
 * `decideWait` below gives up at `now >= until`. An inclusive upper bound would
 * make the deadline millisecond belong to both outcomes at once, and would make
 * the window `timeoutMinutes` plus one millisecond. Half-open makes the wait
 * exactly as long as the author asked for and leaves no instant ambiguous.
 */
export function isInWaitWindow(wait: JourneyWaitState, at: Date): boolean {
  const ms = at.getTime();
  return ms >= Date.parse(wait.since) && ms < Date.parse(wait.until);
}

/**
 * What an armed wait should do on this tick.
 *
 * ORDER MATTERS, and it is the non-obvious half: an event INSIDE THE WINDOW
 * wins even when the deadline has already passed. The poll runs on the cron, so
 * a tick can easily land after `until` — a late cron, a busy queue, a deploy —
 * and an event that genuinely arrived inside the window would otherwise be
 * discarded as a timeout. The question the trace has to answer is "did the thing
 * happen", not "was the engine punctual". Checking the timeout first would make
 * the answer depend on scheduler jitter.
 *
 * Which is exactly why this takes the event's TIMESTAMP and not a boolean. With
 * a boolean, "found" and "found in time" are the same value, and letting it beat
 * the deadline means a late tick at 10:30 resumes on an event stamped 10:20 for
 * a wait that expired at 10:00 — the run takes the "it happened" path when the
 * author's window closed half an hour earlier. Tolerating scheduler jitter must
 * not turn into extending the wait by however long the cron was late.
 *
 * The wake query is bounded by the same window, so this is belt and braces. It
 * is worth having as a pure function anyway: the rule is stated once, in the one
 * place both the runner and its tests can reach.
 */
export function decideWait(
  wait: JourneyWaitState,
  now: Date,
  wokeAt: Date | null,
): WaitDecision {
  if (wokeAt && isInWaitWindow(wait, wokeAt)) return { kind: "woken" };
  if (now.getTime() >= Date.parse(wait.until)) return { kind: "timed_out" };
  return { kind: "keep_waiting", nextRunAt: waitPollAt(wait, now) };
}

/** How long a wait has been armed, for the trace. */
export function waitedMs(wait: JourneyWaitState, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(wait.since));
}
