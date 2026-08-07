import { JOURNEY_LIMITS } from "./journeyTypes";

/**
 * WHERE A RUN IS. The single most important type in the engine.
 *
 * ── The decision: nested tree, path cursor — NOT compiled-flat ──────────────
 *
 * The obvious way to walk nested sequences is a call stack, which works when a
 * script runs to completion inside one process. Ours does not:
 * `processOneRun` executes at most twenty steps and then PARKS, and
 * a run can sit on a `wait` for three days before a different cron process picks
 * it up. There is no call stack to resume — the position has to be a value in
 * the database.
 *
 * The alternative was to keep the flat step list and COMPILE `choose`/`repeat`
 * down to it (branch targets and back-edges). Rejected, for three concrete
 * reasons rather than taste:
 *
 *   1. It does not actually remove the state. A compiled `repeat` still needs an
 *      iteration counter and, for for_each, the item list, somewhere durable —
 *      so you end up storing a cursor anyway, just an implicit one smeared
 *      across `context`.
 *   2. It defeats requirement 3. Compilation has to expand EVERY branch of every
 *      `choose` up front, which is exactly the ten-branches-parsed-per-tick cost
 *      that lazy preparation exists to avoid.
 *   3. It destroys the trace. Once a repeat is a back-edge, the step in
 *      iteration three IS the step in iteration one — the same node, revisited.
 *      That is the reported problem, not a side effect.
 *
 * So: the definition stays a FLAT top-level list (every pre-existing definition,
 * every parked run, and the whole builder keep working unchanged), and the two
 * new container steps own nested sequences. Position is `stepId` — the top-level
 * step — plus a stack of frames, one per container entered.
 *
 * ── How a run parked mid-repeat resumes three days later ────────────────────
 *
 * The cursor is plain JSON in `JourneyRun.cursor`. It names the container step
 * by id, the iteration, and the index within that iteration's sequence, so a
 * fresh process rebuilds the position by walking the (immutable, version-pinned)
 * definition — no in-memory state is required and none is assumed. `items` for a
 * for_each is SNAPSHOT into the frame at loop entry, so the loop iterates what
 * it started with even if the contact's tags changed while it was parked.
 *
 * A run written before any of this exists has `cursor = null`; `parseCursor`
 * reads it as `{ stepId: currentStepId, frames: [] }`, which is precisely the
 * old behaviour.
 */

export type ChooseFrame = {
  kind: "choose";
  /** The container step's id — checked on resume, so a mismatched cursor aborts
   *  cleanly instead of executing some other step's branch. */
  step: string;
  /** Index into `options`, or "default" for the fallback sequence. */
  option: number | "default";
  /** Position within that option's sequence. */
  index: number;
};

export type RepeatFrame = {
  kind: "repeat";
  step: string;
  /** 0-based. It is IN THE TRACE PATH — that is what makes iteration three
   *  distinguishable from iteration one. */
  iteration: number;
  index: number;
  /** for_each only: the list snapshot taken at loop entry. */
  items?: unknown[];
};

export type JourneyFrame = ChooseFrame | RepeatFrame;

/**
 * An ARMED `wait_for_trigger`. Position-adjacent state, so it lives with the
 * position rather than in `run.context`.
 *
 * It cannot live in the context: `processOneRun` reloads the context from the
 * database after every step, which is the same reason `repeat` variables are
 * derived rather than stored. It cannot live on the step definition either — a
 * version is immutable and shared by every run pinned to it.
 *
 * `path` is the HIERARCHICAL trace path, not the step id, and that is the whole
 * point. A `wait_for_trigger` inside a `repeat` arms once PER ITERATION: keyed
 * by step id, iteration 2 would inherit iteration 0's `since` and wake instantly
 * on the event iteration 0 was already woken by. Keyed by path,
 * `chase/repeat/2/sequence/0` is a different wait from
 * `chase/repeat/0/sequence/0`, which is the same reason the step log is keyed on
 * the path.
 */
export type JourneyWaitState = {
  /** The trace path of the step that armed this wait. */
  path: string;
  /**
   * ISO instant. Only events created at or after it may wake the run.
   *
   * Captured at the moment the runner DECIDES to wait, not at the moment the
   * park is committed. An event that lands in between is then still `>= since`
   * and is found by the next poll; taking the instant at commit time would put
   * it before the watermark and lose it silently, forever.
   */
  since: string;
  /** ISO instant the wait gives up at. Always set — see JOURNEY_LIMITS.waitDays. */
  until: string;
};

export type JourneyCursor = {
  /** The TOP-LEVEL step. Null means the run has run off the end and is done. */
  stepId: string | null;
  /** Outermost first. Empty for a flat journey — the pre-existing shape. */
  frames: JourneyFrame[];
  /** Present only while a wait_for_trigger at `wait.path` is armed. */
  wait?: JourneyWaitState;
};

export function flatCursor(stepId: string | null): JourneyCursor {
  return { stepId, frames: [] };
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Read a persisted wait, or nothing.
 *
 * A malformed wait drops the WAIT ONLY, never the cursor: the step re-arms on
 * the next tick and loses at most one poll interval, whereas degrading the whole
 * cursor to flat would restart an enclosing loop from the top.
 */
function parseWait(value: unknown): JourneyWaitState | undefined {
  if (!isRecord(value)) return undefined;
  const { path, since, until } = value;
  if (typeof path !== "string" || !path || path.length > 500) return undefined;
  if (!isIsoInstant(since) || !isIsoInstant(until)) return undefined;
  return { path, since, until };
}

/** Drop an armed wait — on resolution, and on any step that did not arm it. */
export function clearWait(cursor: JourneyCursor): JourneyCursor {
  if (!cursor.wait) return cursor;
  return { stepId: cursor.stepId, frames: cursor.frames.map((frame) => ({ ...frame })) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a persisted cursor.
 *
 * `fallbackStepId` is `JourneyRun.currentStepId`, which is the ONLY position a
 * run created before this existed has. Falling back to it rather than throwing
 * is what lets already-parked runs resume across the deploy.
 */
export function parseCursor(value: unknown, fallbackStepId: string | null): JourneyCursor {
  if (!isRecord(value) || !Array.isArray(value.frames)) return flatCursor(fallbackStepId);
  const stepId = typeof value.stepId === "string" && value.stepId ? value.stepId : null;
  // Depth is capped at parse time; a stored cursor deeper than that is corrupt
  // or hand-edited, and running it would walk past the validated structure.
  if (value.frames.length > JOURNEY_LIMITS.depth) return flatCursor(fallbackStepId);

  const frames: JourneyFrame[] = [];
  for (const raw of value.frames) {
    if (!isRecord(raw) || typeof raw.step !== "string") return flatCursor(fallbackStepId);
    const index = Number(raw.index);
    if (!Number.isInteger(index) || index < 0) return flatCursor(fallbackStepId);
    if (raw.kind === "choose") {
      const option = raw.option === "default" ? "default" : Number(raw.option);
      if (option !== "default" && (!Number.isInteger(option) || option < 0)) {
        return flatCursor(fallbackStepId);
      }
      frames.push({ kind: "choose", step: raw.step, option, index });
    } else if (raw.kind === "repeat") {
      const iteration = Number(raw.iteration);
      if (!Number.isInteger(iteration) || iteration < 0) return flatCursor(fallbackStepId);
      frames.push({
        kind: "repeat",
        step: raw.step,
        iteration,
        index,
        ...(Array.isArray(raw.items) ? { items: raw.items } : {}),
      });
    } else {
      return flatCursor(fallbackStepId);
    }
  }
  const wait = parseWait(value.wait);
  return wait ? { stepId, frames, wait } : { stepId, frames };
}

/** One frame's contribution to the trace path. */
export function frameSegment(frame: JourneyFrame): string {
  return frame.kind === "choose"
    ? `choose/${frame.option}/sequence/${frame.index}`
    : `repeat/${frame.iteration}/sequence/${frame.index}`;
}

/**
 * The same segment with the iteration number REMOVED.
 *
 * Used only as a cache key. Every iteration of a repeat executes the identical
 * sequence, so keying the prepared form by the trace path — which carries the
 * iteration precisely so iterations are distinguishable — would re-parse a
 * nested branch once per iteration and quietly undo the lazy preparation it was
 * meant to enable.
 */
export function frameKeySegment(frame: JourneyFrame): string {
  return frame.kind === "choose"
    ? `choose/${frame.option}/sequence/${frame.index}`
    : `repeat/sequence/${frame.index}`;
}

/**
 * The hierarchical trace path, e.g. `"triage/choose/1/sequence/0"`.
 *
 * For a FLAT journey this is exactly the step id — unchanged from before, which
 * is why every existing JourneyStepLog row and the whole activity trace keep
 * working. Nesting appends one segment per frame:
 *
 *   welcome                                  a top-level step
 *   triage/choose/1/sequence/0               first step of the second branch
 *   blast/repeat/2/sequence/1                second step of the THIRD iteration
 *
 * The iteration number is in the path on purpose. `@@unique([runId, stepId])`
 * could not hold once a step executes more than once; `@@unique([runId, path])`
 * can, because the path of iteration 3 differs from the path of iteration 1.
 */
export function cursorPath(cursor: JourneyCursor): string {
  const head = cursor.stepId ?? "end";
  const path = [head, ...cursor.frames.map(frameSegment)].join("/");
  // Bounded by depth (5 frames × 4 short segments), but the column should never
  // be at the mercy of an id we did not generate.
  return path.slice(0, 500);
}

/**
 * A structural copy — the runner mutates frames and must not alias run state.
 *
 * An armed wait is CARRIED, not quietly dropped. advanceCursor clones, and a
 * clone that silently lost the wait would make "the wait is cleared" an
 * invisible side effect of moving — right by accident on the advance that
 * resolves it, and wrong everywhere else. Clearing is `clearWait`, spelled out
 * at the two places that mean it.
 */
export function cloneCursor(cursor: JourneyCursor): JourneyCursor {
  return {
    stepId: cursor.stepId,
    frames: cursor.frames.map((frame) => ({ ...frame })),
    ...(cursor.wait ? { wait: { ...cursor.wait } } : {}),
  };
}

/**
 * The loop variables the innermost `repeat` publishes to its body.
 *
 * DERIVED from the cursor every step rather than stored in `run.context`, and
 * that is deliberate: `processOneRun` refreshes the context from the database
 * after every step, so anything written into it would be wiped on the next pass.
 * Deriving it also means there is exactly one source of truth for "which
 * iteration is this", which is the cursor that the trace path already uses.
 */
export function repeatVars(cursor: JourneyCursor): Record<string, unknown> | null {
  for (let i = cursor.frames.length - 1; i >= 0; i--) {
    const frame = cursor.frames[i];
    if (frame.kind !== "repeat") continue;
    const total = frame.items?.length ?? null;
    return {
      // 1-based: the first pass is "1", not "0". Journey authors are not
      // programmers, and "iteration 0" reads as a bug in a message body.
      index: frame.iteration + 1,
      first: frame.iteration === 0,
      last: total == null ? false : frame.iteration === total - 1,
      item: frame.items ? frame.items[frame.iteration] : null,
    };
  }
  return null;
}

/** The context a step sees: the run context plus the enclosing loop's variables. */
export function withRepeatVars<T extends Record<string, unknown>>(context: T, cursor: JourneyCursor): T {
  const repeat = repeatVars(cursor);
  return repeat ? ({ ...context, repeat } as T) : context;
}
