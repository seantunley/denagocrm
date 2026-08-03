import { AbortJourney } from "./journeyControlFlow";
import {
  JOURNEY_LIMITS,
  evaluateConditions,
  parseConditionGroup,
  parseJourneySequence,
  stepById,
  valueAtPath,
  type JourneyConditionGroup,
  type JourneyDefinition,
  type JourneyStep,
  type RepeatMode,
} from "./journeyTypes";
import {
  cloneCursor,
  frameKeySegment,
  frameSegment,
  withRepeatVars,
  type ChooseFrame,
  type JourneyCursor,
  type JourneyFrame,
  type RepeatFrame,
} from "./journeyCursor";

/**
 * LAZY SUB-SCRIPT PREPARATION.
 *
 * Home Assistant instantiates a branch's sub-`Script` only when that branch is
 * first reached and caches it on the parent by index. The equivalent problem
 * here is sharper, because `processOneRun` re-parses the definition from JSON
 * EVERY TICK for EVERY run: a `choose` with ten branches would validate ten
 * sequences and ten condition groups to execute one of them, on every tick, for
 * every enrolled person.
 *
 * So the split is: `parseJourneyDefinition(def, { deep: false })` validates the
 * top level, and everything below a container is prepared here — once, on first
 * entry — and memoised. Nothing skips validation; it moves to the branch that
 * actually runs.
 *
 * Keyed by journeyVersionId because a version is IMMUTABLE once published. A run
 * is pinned to its version, so a cached branch can never go stale under it.
 */
export class JourneyScriptCache {
  private readonly entries = new Map<string, { value: unknown }>();

  constructor(private readonly max = 500) {}

  /** Every key actually BUILT, in build order. The laziness is asserted on this. */
  get preparedKeys(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }

  memo<T>(key: string, build: () => T): T {
    // `has`, not a truthy `get`: a branch with no conditions prepares to null,
    // and a null that never memoises would be rebuilt on every single step.
    const hit = this.entries.get(key);
    if (hit) return hit.value as T;
    const value = build();
    this.entries.set(key, { value });
    if (this.entries.size > this.max) {
      // FIFO. A long-lived process must not accumulate every branch of every
      // version it has ever touched; re-preparing an evicted branch is cheap.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }
}

let sharedCache = new JourneyScriptCache();

export function journeyScriptCache(): JourneyScriptCache {
  return sharedCache;
}

/** Tests only — a fresh cache so laziness can be observed from a known state. */
export function resetJourneyScriptCache() {
  sharedCache = new JourneyScriptCache();
}

/** Everything the walkers need to prepare a branch. */
export type ScriptLookup = {
  cache: JourneyScriptCache;
  /** Immutable published version, so cached branches can never go stale. */
  versionId: string;
};

const key = (lookup: ScriptLookup, path: string) => `${lookup.versionId}#${path}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function chooseOptions(step: JourneyStep): unknown[] {
  const options = step.config.options;
  if (!Array.isArray(options)) throw new AbortJourney(`Choose ${step.id} has no options`);
  return options;
}

/**
 * The sequence a frame is executing, prepared on demand.
 *
 * `keyPath` is the ITERATION-FREE path (see frameKeySegment): the body of a
 * repeat is the same sequence on pass 1 and pass 40, and keying it by the trace
 * path would re-validate it forty times.
 */
function sequenceForFrame(
  lookup: ScriptLookup,
  container: JourneyStep,
  keyPath: string,
  frame: JourneyFrame,
): JourneyStep[] {
  if (frame.kind === "repeat") {
    return lookup.cache.memo(key(lookup, `${keyPath}/repeat/sequence`), () =>
      parseJourneySequence(container.config.sequence, 1, `Repeat ${container.id}`),
    );
  }
  if (frame.option === "default") {
    return lookup.cache.memo(key(lookup, `${keyPath}/choose/default/sequence`), () =>
      parseJourneySequence(container.config.default, 1, `Choose ${container.id} default`),
    );
  }
  const option = chooseOptions(container)[frame.option];
  if (!isRecord(option)) throw new AbortJourney(`Choose ${container.id} has no option ${frame.option}`);
  return lookup.cache.memo(key(lookup, `${keyPath}/choose/${frame.option}/sequence`), () =>
    parseJourneySequence(option.sequence, 1, `Choose ${container.id} option ${frame.option}`),
  );
}

export type CursorPosition = {
  step: JourneyStep;
  /** Hierarchical trace path — carries iteration numbers. */
  path: string;
  /** Cache path — identical but iteration-free. */
  keyPath: string;
};

/**
 * Walk the first `depth` frames and return the step they land on.
 *
 * `depth = frames.length` gives the step to EXECUTE. `depth = frames.length - 1`
 * gives the CONTAINER of the innermost frame, which is what advancing needs.
 *
 * This is the whole resumability story: a process that has never seen this run
 * before rebuilds its exact position from the definition plus the stored cursor,
 * with no in-memory state carried over.
 */
export function walkCursor(
  definition: JourneyDefinition,
  cursor: JourneyCursor,
  depth: number,
  lookup: ScriptLookup,
): CursorPosition | null {
  if (!cursor.stepId) return null;
  let step = stepById(definition, cursor.stepId);
  if (!step) return null;
  let path = cursor.stepId;
  let keyPath = cursor.stepId;

  for (let i = 0; i < depth; i++) {
    const frame = cursor.frames[i];
    // The frame names its container. A mismatch means the cursor and the
    // definition have diverged — abort cleanly rather than execute whatever
    // step happens to sit at that index in some other branch.
    if (frame.step !== step.id) {
      throw new AbortJourney(`Journey cursor no longer matches its definition at ${path}`);
    }
    const sequence = sequenceForFrame(lookup, step, keyPath, frame);
    const child = sequence[frame.index];
    path = `${path}/${frameSegment(frame)}`;
    keyPath = `${keyPath}/${frameKeySegment(frame)}`;
    if (!child) throw new AbortJourney(`Journey cursor points past the end of ${path}`);
    step = child;
  }
  return { step, path, keyPath };
}

/** The step the cursor currently points at, or null when the run is finished. */
export function resolveCursor(
  definition: JourneyDefinition,
  cursor: JourneyCursor,
  lookup: ScriptLookup,
): CursorPosition | null {
  return walkCursor(definition, cursor, cursor.frames.length, lookup);
}

/* ── choose ──────────────────────────────────────────────────────────────── */

/**
 * Pick a branch, touching as little as possible.
 *
 * Options are tested IN ORDER and the loop returns on the first match, so the
 * conditions of later options are never parsed and — the expensive half — no
 * option's SEQUENCE is prepared except the one that wins. An option with no
 * `conditions` is an unconditional else, which is how HA behaves too.
 *
 * Returns null when nothing matched and there is no default: the run falls
 * through to the choose step's own nextStepId.
 */
export function chooseBranch(
  step: JourneyStep,
  keyPath: string,
  context: Record<string, unknown>,
  lookup: ScriptLookup,
): { option: number | "default"; conditionIndex: number } | null {
  const options = chooseOptions(step);
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (!isRecord(option)) throw new AbortJourney(`Choose ${step.id} option ${index} is not an object`);
    const conditions = lookup.cache.memo<JourneyConditionGroup | null>(
      key(lookup, `${keyPath}/choose/${index}/conditions`),
      () => parseConditionGroup(option.conditions),
    );
    if (evaluateConditions(conditions, context)) return { option: index, conditionIndex: index };
  }
  return step.config.default != null ? { option: "default", conditionIndex: -1 } : null;
}

export function enterChoose(
  step: JourneyStep,
  option: number | "default",
): ChooseFrame {
  return { kind: "choose", step: step.id, option, index: 0 };
}

/* ── repeat ──────────────────────────────────────────────────────────────── */

export type PreparedRepeat = {
  mode: RepeatMode;
  count: number;
  whileGroup: JourneyConditionGroup | null;
  untilGroup: JourneyConditionGroup | null;
  items: unknown[] | null;
  itemsPath: string | null;
};

export function prepareRepeat(
  step: JourneyStep,
  keyPath: string,
  lookup: ScriptLookup,
): PreparedRepeat {
  return lookup.cache.memo(key(lookup, `${keyPath}/repeat/config`), () => {
    const config = step.config;
    const mode = String(config.mode ?? "") as RepeatMode;
    return {
      mode,
      count: Number(config.count ?? 0),
      whileGroup: mode === "while" ? parseConditionGroup(config.while) : null,
      untilGroup: mode === "until" ? parseConditionGroup(config.until) : null,
      items: Array.isArray(config.items) ? config.items : null,
      itemsPath: typeof config.itemsPath === "string" ? config.itemsPath : null,
    };
  });
}

function resolveItems(prepared: PreparedRepeat, context: Record<string, unknown>): unknown[] {
  const raw = prepared.items ?? (prepared.itemsPath ? valueAtPath(context, prepared.itemsPath) : null);
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, JOURNEY_LIMITS.forEachItems);
}

/** The context a repeat's own conditions see, for a given iteration of a frame. */
function contextForIteration(
  context: Record<string, unknown>,
  frame: RepeatFrame,
  iteration: number,
): Record<string, unknown> {
  return withRepeatVars(context, { stepId: null, frames: [{ ...frame, iteration }] });
}

/**
 * Decide whether the loop runs at all, and snapshot what it iterates.
 *
 * for_each SNAPSHOTS its list here rather than re-reading it each pass. A run can
 * sit parked inside this loop for days; re-resolving `contact.tags` on pass four
 * would iterate a list that has since changed length, which is how a loop either
 * skips items or runs off its own end.
 *
 * Returns null to skip the loop entirely — a count of zero, an empty list, or a
 * `while` that is already false — in which case the run continues at the repeat
 * step's nextStepId.
 */
export function enterRepeat(
  step: JourneyStep,
  keyPath: string,
  context: Record<string, unknown>,
  lookup: ScriptLookup,
): RepeatFrame | null {
  const prepared = prepareRepeat(step, keyPath, lookup);
  const frame: RepeatFrame = { kind: "repeat", step: step.id, iteration: 0, index: 0 };

  if (prepared.mode === "count") return prepared.count >= 1 ? frame : null;
  if (prepared.mode === "for_each") {
    const items = resolveItems(prepared, context);
    if (items.length === 0) return null;
    frame.items = items;
    return frame;
  }
  if (prepared.mode === "while") {
    return evaluateConditions(prepared.whileGroup, contextForIteration(context, frame, 0)) ? frame : null;
  }
  // until is a do-until: the body always runs at least once, and the condition
  // is what decides whether it runs AGAIN.
  return frame;
}

/**
 * After an iteration finishes: run the body again, or fall out of the loop?
 *
 * The iteration ceiling is checked FIRST and for every mode, including `count`
 * and `for_each` whose own bounds the parser already validated — a hand-written
 * definition that skipped the builder is exactly the case this is here for.
 */
export function shouldContinueRepeat(
  container: JourneyStep,
  keyPath: string,
  frame: RepeatFrame,
  context: Record<string, unknown>,
  lookup: ScriptLookup,
): boolean {
  const next = frame.iteration + 1;
  const prepared = prepareRepeat(container, keyPath, lookup);
  const wantsAnother = (() => {
    switch (prepared.mode) {
      case "count":
        return next < prepared.count;
      case "for_each":
        return next < (frame.items?.length ?? 0);
      case "while":
        return evaluateConditions(prepared.whileGroup, contextForIteration(context, frame, next));
      default:
        // until is evaluated against the iteration that JUST RAN, then negated:
        // "repeat until X" continues while X is false.
        return !evaluateConditions(prepared.untilGroup, contextForIteration(context, frame, frame.iteration));
    }
  })();

  // ASK WHETHER THE LOOP IS FINISHED BEFORE ENFORCING THE CEILING.
  //
  // The ceiling used to be checked first, which rejected the documented
  // maximum: `count: 100` runs iterations 0…99, and after the last one `next`
  // is 100 — so a loop that had just completed every pass the author asked for
  // was aborted as a runaway and the run marked failed. A 100-item `for_each`
  // did the same, and `forEachItems` is likewise capped at 100. The limit and
  // the validator disagreed about what "100 iterations" means.
  //
  // The comparison is right — `next >= 100` is pass 101 — it was only being
  // asked at the wrong moment. A genuine runaway `while` still hits it, because
  // that is the case where wantsAnother stays true forever.
  if (!wantsAnother) return false;
  if (next >= JOURNEY_LIMITS.repeatIterations) {
    throw new AbortJourney(
      `Repeat ${container.id} exceeded ${JOURNEY_LIMITS.repeatIterations} iterations`,
    );
  }
  return true;
}

/* ── advancing ───────────────────────────────────────────────────────────── */

/**
 * Pop every exhausted frame, looping any repeat that still has passes left.
 *
 * Restores the runner's central invariant: on return the cursor either points at
 * a real step or is finished (`stepId === null`, no frames). Everything about
 * "what happens when a sequence ends" lives here and nowhere else.
 */
export function normalizeCursor(args: {
  definition: JourneyDefinition;
  cursor: JourneyCursor;
  context: Record<string, unknown>;
  lookup: ScriptLookup;
}): JourneyCursor {
  const { definition, context, lookup } = args;
  const cursor = cloneCursor(args.cursor);

  while (cursor.frames.length > 0) {
    const depth = cursor.frames.length - 1;
    const frame = cursor.frames[depth];
    const container = walkCursor(definition, cursor, depth, lookup);
    if (!container) throw new AbortJourney("Journey cursor lost the step that owns it");

    const sequence = sequenceForFrame(lookup, container.step, container.keyPath, frame);
    if (frame.index < sequence.length) return cursor;

    if (frame.kind === "repeat" && shouldContinueRepeat(container.step, container.keyPath, frame, context, lookup)) {
      frame.iteration += 1;
      frame.index = 0;
      return cursor;
    }

    cursor.frames.pop();
    if (cursor.frames.length === 0) {
      cursor.stepId = container.step.nextStepId ?? null;
      return cursor;
    }
    cursor.frames[cursor.frames.length - 1].index += 1;
  }
  return cursor;
}

/**
 * Move past the step that just executed.
 *
 * `override` is the two-way `condition` step's branch target and applies at TOP
 * LEVEL ONLY — the parser rejects trueStepId/falseStepId inside a sequence,
 * because jumping to a top-level id from inside a repeat would abandon the very
 * frames that make the loop resumable.
 */
export function advanceCursor(args: {
  definition: JourneyDefinition;
  cursor: JourneyCursor;
  context: Record<string, unknown>;
  lookup: ScriptLookup;
  override?: string | null;
}): JourneyCursor {
  const { definition, context, lookup, override } = args;
  const cursor = cloneCursor(args.cursor);

  if (cursor.frames.length === 0) {
    const step = stepById(definition, cursor.stepId);
    cursor.stepId = override !== undefined ? override : step?.nextStepId ?? null;
    return cursor;
  }
  cursor.frames[cursor.frames.length - 1].index += 1;
  return normalizeCursor({ definition, cursor, context, lookup });
}

/** Push a frame — entering a container — and land on its first step. */
export function pushFrame(cursor: JourneyCursor, frame: JourneyFrame): JourneyCursor {
  const next = cloneCursor(cursor);
  next.frames.push(frame);
  return next;
}
