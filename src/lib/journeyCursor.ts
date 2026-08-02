import { JOURNEY_LIMITS } from "./journeyTypes";

/**
 * WHERE A RUN IS. The single most important type in the engine.
 *
 * ── The decision: nested tree, path cursor — NOT compiled-flat ──────────────
 *
 * Home Assistant nests sequences as arrays and walks them with a Python call
 * stack, which it can do because a HA script runs to completion in one process.
 * Ours cannot: `processOneRun` executes at most twenty steps and then PARKS, and
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

export type JourneyCursor = {
  /** The TOP-LEVEL step. Null means the run has run off the end and is done. */
  stepId: string | null;
  /** Outermost first. Empty for a flat journey — the pre-existing shape. */
  frames: JourneyFrame[];
};

export function flatCursor(stepId: string | null): JourneyCursor {
  return { stepId, frames: [] };
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
  return { stepId, frames };
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
 * The hierarchical trace path, after HA's `"0/sequence/1/conditions"`.
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

/** A structural copy — the runner mutates frames and must not alias run state. */
export function cloneCursor(cursor: JourneyCursor): JourneyCursor {
  return {
    stepId: cursor.stepId,
    frames: cursor.frames.map((frame) => ({ ...frame })),
  };
}

/**
 * The `repeat` variables the innermost loop publishes, after HA's `repeat`
 * template variable.
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
      // 1-based, like HA's repeat.index — the first pass is "1", not "0".
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
