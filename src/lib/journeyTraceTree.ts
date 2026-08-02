import { JOURNEY_LIMITS, type ConditionExplanation } from "./journeyTypes";

/**
 * READING A TRACE PATH BACK — the inverse of `cursorPath`.
 *
 * The engine writes one `JourneyStepLog` row per EXECUTION, keyed on the
 * hierarchical path (`blast/repeat/2/sequence/1`) rather than the step id,
 * because a `repeat` runs the same id once per pass and `@@unique([runId,
 * stepId])` could not survive that. Which means the log is no longer a list: it
 * is a flattened tree, and rendering it as a list would put iteration three's
 * failure next to iteration one's success with nothing to say they are the same
 * step at different times.
 *
 * Everything here is PURE and deliberately kept out of both the server module
 * (`journeyTrace.ts`, which is `server-only`) and the component. The
 * path-grammar and grouping rules are the part that can silently be wrong —
 * indexing a sequence by iteration instead of index reads the correct-looking
 * step from the wrong place — so they live where a test can drive them directly.
 */

/** One container hop in a trace path. */
export type TraceSegment =
  | { kind: "choose"; option: number | "default"; index: number }
  | { kind: "repeat"; iteration: number; index: number };

export type TracePath = {
  /** The top-level step the path starts at. */
  stepId: string;
  /** Outermost first — the same order as the cursor frames that produced it. */
  segments: TraceSegment[];
};

/** `choose/1/sequence/0` — one segment is always four tokens. */
const SEGMENT_TOKENS = 4;

/**
 * A path token as a non-negative integer, or null.
 *
 * Tested with a regex rather than `Number()`: `Number("")` is 0 and
 * `Number(" 2 ")` is 2, so a malformed path would parse as a valid position and
 * be drawn under the wrong branch.
 */
function nonNegative(token: string | undefined): number | null {
  if (typeof token !== "string" || !/^\d+$/.test(token)) return null;
  const value = Number(token);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Split a stored path into its head step and container hops.
 *
 * Returns null for anything that does not match the grammar exactly. Step ids
 * are `[a-zA-Z0-9_-]` (see cleanId in journeyTypes), so the head can never
 * itself contain a `/` and reading left to right is unambiguous.
 */
export function parseTracePath(path: string): TracePath | null {
  const tokens = path.split("/");
  const head = tokens[0];
  if (!head) return null;
  const tail = tokens.length - 1;
  if (tail % SEGMENT_TOKENS !== 0) return null;
  // The cursor stack is capped at this depth at parse time, so a deeper path did
  // not come from the engine.
  if (tail / SEGMENT_TOKENS > JOURNEY_LIMITS.depth) return null;

  const segments: TraceSegment[] = [];
  for (let at = 1; at < tokens.length; at += SEGMENT_TOKENS) {
    const [kind, key, sequence, rawIndex] = tokens.slice(at, at + SEGMENT_TOKENS);
    if (sequence !== "sequence") return null;
    const index = nonNegative(rawIndex);
    if (index === null) return null;
    if (kind === "choose") {
      const option = key === "default" ? "default" : nonNegative(key);
      if (option === null) return null;
      segments.push({ kind: "choose", option, index });
    } else if (kind === "repeat") {
      const iteration = nonNegative(key);
      if (iteration === null) return null;
      segments.push({ kind: "repeat", iteration, index });
    } else {
      return null;
    }
  }
  return { stepId: head, segments };
}

/**
 * One segment back to text.
 *
 * Deliberately a second implementation of `frameSegment` rather than a call to
 * it: that one takes a cursor FRAME, which also carries the container's step id
 * and a for_each item snapshot the path never had.
 */
export function segmentText(segment: TraceSegment): string {
  return segment.kind === "choose"
    ? `choose/${segment.option}/sequence/${segment.index}`
    : `repeat/${segment.iteration}/sequence/${segment.index}`;
}

/** The path of the CONTAINER that owns this execution, or null at top level. */
export function parentTracePath(parsed: TracePath): string | null {
  if (parsed.segments.length === 0) return null;
  return [parsed.stepId, ...parsed.segments.slice(0, -1).map(segmentText)].join("/");
}

/* ── the tree ────────────────────────────────────────────────────────────── */

/** One recorded EXECUTION of a step — a JourneyStepLog row, shaped for the UI. */
export type TraceStep = {
  path: string;
  stepId: string;
  stepType: string;
  /** running | completed | skipped | failed. */
  status: string;
  note: string | null;
  startedAt: Date;
  completedAt: Date | null;
  /** Milliseconds the step took, or null while it is still open. */
  durationMs: number | null;
  /** Per-clause condition results, or null when the step recorded none. */
  clauses: ConditionExplanation[] | null;
  /** When the engine parked this step to try it AGAIN. A held send sets it. */
  nextRunAt: Date | null;
  /** A repeat container's snapshotted for_each list length. */
  plannedIterations: number | null;
};

export type TraceGroup = {
  kind: "choose" | "repeat";
  /** A choose option index (or "default"), or a 0-based repeat iteration. */
  key: number | "default";
  nodes: TraceNode[];
};

export type TraceNode = {
  step: TraceStep;
  /** Null when the stored path does not match the grammar. */
  parsed: TracePath | null;
  /** Nesting level, 0 at the top. */
  depth: number;
  /** One group per branch entered or iteration run, in order. */
  groups: TraceGroup[];
  /** The container that owns this execution has no log row of its own. */
  orphaned: boolean;
};

function groupFor(parent: TraceNode, segment: TraceSegment): TraceGroup {
  const key = segment.kind === "choose" ? segment.option : segment.iteration;
  const existing = parent.groups.find((group) => group.kind === segment.kind && group.key === key);
  if (existing) return existing;
  const group: TraceGroup = { kind: segment.kind, key, nodes: [] };
  parent.groups.push(group);
  return group;
}

/** "default" sorts after every numbered option, which is where it runs. */
function groupOrder(group: TraceGroup): number {
  return group.key === "default" ? Number.MAX_SAFE_INTEGER : group.key;
}

function lastIndex(node: TraceNode): number {
  const segments = node.parsed?.segments ?? [];
  return segments.length > 0 ? segments[segments.length - 1].index : 0;
}

function finalise(node: TraceNode, depth: number) {
  node.depth = depth;
  node.groups.sort((a, b) => groupOrder(a) - groupOrder(b));
  for (const group of node.groups) {
    // Order within a branch is the SEQUENCE order, not the clock. A step held by
    // quiet hours has its startedAt reset when it is finally retried, which would
    // otherwise jump it to the bottom of the branch it belongs in the middle of.
    group.nodes.sort(
      (a, b) => lastIndex(a) - lastIndex(b) || a.step.startedAt.getTime() - b.step.startedAt.getTime(),
    );
    for (const child of group.nodes) finalise(child, depth + 1);
  }
}

/**
 * The flat step log as the tree it actually is.
 *
 * NOTHING IS EVER DROPPED. A row whose path will not parse, a duplicate path, or
 * a child whose container row has been purged by retention all surface at the
 * top level marked `orphaned` rather than disappearing into a `Map.get` that
 * returned undefined. A step that executed and is not on screen is precisely the
 * failure this screen exists to remove.
 */
export function buildTraceTree(steps: TraceStep[]): TraceNode[] {
  const byPath = new Map<string, TraceNode>();
  const all: TraceNode[] = [];

  for (const step of steps) {
    const node: TraceNode = {
      step,
      parsed: parseTracePath(step.path),
      depth: 0,
      groups: [],
      orphaned: false,
    };
    all.push(node);
    if (!byPath.has(step.path)) byPath.set(step.path, node);
  }

  const roots: TraceNode[] = [];
  for (const node of all) {
    const parentPath = node.parsed ? parentTracePath(node.parsed) : null;
    // `byPath.get(path) !== node` means a second row claimed the same path. The
    // unique index makes that impossible in the database; if it ever happens
    // anyway, showing both is the only honest answer.
    const parent = parentPath === null || byPath.get(node.step.path) !== node
      ? null
      : byPath.get(parentPath) ?? null;
    if (!parent) {
      node.orphaned = parentPath !== null;
      roots.push(node);
      continue;
    }
    groupFor(parent, node.parsed!.segments[node.parsed!.segments.length - 1]).nodes.push(node);
  }

  // Top level IS chronological — a back-edge revisits a step id, and the upsert
  // resets startedAt, so the clock is what says where the run went.
  roots.sort((a, b) => a.step.startedAt.getTime() - b.step.startedAt.getTime());
  for (const root of roots) finalise(root, 0);
  return roots;
}

/** Every node in the tree, depth first, in the order it is drawn. */
export function flattenTrace(nodes: TraceNode[]): TraceNode[] {
  return nodes.flatMap((node) => [node, ...node.groups.flatMap((group) => flattenTrace(group.nodes))]);
}

/* ── what a step's status MEANS ──────────────────────────────────────────── */

/** Statuses in which a run may still do more work. */
export const OPEN_RUN_STATUSES = new Set(["queued", "running", "waiting", "blocked"]);

/**
 * A step that ran, did NOT finish, and is coming back.
 *
 * This is the quiet-hours case. The runner writes `status: "running"` with a
 * `nextRunAt` for a send it held rather than performed, because "completed:
 * Email held for quiet hours" says two opposite things at once. It is neither
 * done nor failed, and `nextRunAt` is what separates it from the row written a
 * moment before the step is actually attempted — that one has no output at all.
 */
export function isHeldStep(step: TraceStep): boolean {
  return step.status === "running" && step.nextRunAt !== null;
}

export type StepOutcome = {
  tone: "success" | "warning" | "danger" | "info" | "neutral";
  label: string;
};

/**
 * The word for one step, given how the RUN as a whole is doing.
 *
 * `running` on a log row means only "started, no completion written", and that
 * is three different situations. Held for retry, genuinely executing now, and
 * abandoned when the run died mid-step all read identically on the row alone;
 * the run's own status is what tells them apart.
 */
export function stepOutcome(step: TraceStep, runStatus: string): StepOutcome {
  if (step.status === "completed") return { tone: "success", label: "Done" };
  if (step.status === "skipped") return { tone: "neutral", label: "Skipped" };
  if (step.status === "failed") return { tone: "danger", label: "Failed" };
  if (isHeldStep(step)) return { tone: "warning", label: "Held" };
  if (OPEN_RUN_STATUSES.has(runStatus)) return { tone: "info", label: "Running" };
  return { tone: "neutral", label: "Never finished" };
}

/* ── repeats ─────────────────────────────────────────────────────────────── */

export type RepeatSummary = {
  /** Iterations that actually left a trace. */
  iterations: number;
  /** Step executions recorded across every iteration, at every depth. */
  executions: number;
  /** Iteration numbers containing a failure, ascending. */
  failed: number[];
  /** Iteration numbers containing a step held for retry, ascending. */
  held: number[];
};

function iterationGroups(node: TraceNode): TraceGroup[] {
  return node.groups.filter((group) => group.kind === "repeat" && typeof group.key === "number");
}

export function summariseRepeat(node: TraceNode): RepeatSummary {
  const summary: RepeatSummary = { iterations: 0, executions: 0, failed: [], held: [] };
  for (const group of iterationGroups(node)) {
    const iteration = group.key as number;
    summary.iterations += 1;
    for (const descendant of flattenTrace(group.nodes)) {
      summary.executions += 1;
      if (descendant.step.status === "failed" && !summary.failed.includes(iteration)) {
        summary.failed.push(iteration);
      }
      if (isHeldStep(descendant.step) && !summary.held.includes(iteration)) {
        summary.held.push(iteration);
      }
    }
  }
  summary.failed.sort((a, b) => a - b);
  summary.held.sort((a, b) => a - b);
  return summary;
}

/**
 * Which iterations are open when the page loads.
 *
 * A hundred-iteration repeat must not be a hundred screens of scroll, and a
 * hundred COLLAPSED iterations are almost as useless — you are hunting the one
 * that went wrong. So: anything that failed or is held, up to `budget`, plus
 * always the first and the last, which are the shape of the loop and where it
 * ended. A short loop opens whole; there is nothing to save.
 *
 * The budget is on the PROBLEM iterations only. An all-failing loop otherwise
 * reinstates the exact wall of scroll this exists to prevent.
 */
export function iterationsToExpand(node: TraceNode, budget = 4): Set<number> {
  const keys = iterationGroups(node)
    .map((group) => group.key as number)
    .sort((a, b) => a - b);
  if (keys.length === 0) return new Set();
  if (keys.length <= budget) return new Set(keys);

  const summary = summariseRepeat(node);
  const open = new Set<number>();
  for (const key of [...new Set([...summary.failed, ...summary.held])].sort((a, b) => a - b)) {
    if (open.size >= budget) break;
    open.add(key);
  }
  open.add(keys[0]);
  open.add(keys[keys.length - 1]);
  return open;
}

/** The choose branch this execution actually entered, or null if none matched. */
export function takenChooseOption(node: TraceNode): number | "default" | null {
  const group = node.groups.find((entry) => entry.kind === "choose");
  return group ? group.key : null;
}

/* ── reading the pinned definition ───────────────────────────────────────── */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The definition node a trace path names.
 *
 * Deliberately LENIENT — it never parses and never throws. A definition that
 * fails deep validation is exactly when someone is reading a trace, and a
 * screen that 500s on the broken journey is no use to them. Anything it cannot
 * resolve comes back null and the caller falls back to the recorded step id.
 */
export function definitionNodeAt(
  definition: unknown,
  parsed: TracePath,
): Record<string, unknown> | null {
  const root = record(definition);
  if (!root) return null;
  let node = list(root.steps).map(record).find((step) => step?.id === parsed.stepId) ?? null;

  for (const segment of parsed.segments) {
    if (!node) return null;
    const config = record(node.config) ?? {};
    const sequence =
      segment.kind === "repeat"
        ? list(config.sequence)
        : segment.option === "default"
          ? list(config.default)
          : list(record(list(config.options)[segment.option])?.sequence);
    // The INDEX within the sequence, never the iteration. Every pass of a repeat
    // runs the identical body, so indexing by iteration would name a plausible
    // but wrong step from pass two onwards — and read as an empty body once the
    // iteration number passed the sequence length.
    node = record(sequence[segment.index]);
  }
  return node;
}

export type BranchOutline = {
  option: number | "default";
  label: string;
  /** How many steps the branch declares. */
  steps: number;
  taken: boolean;
};

function branchLabel(option: Record<string, unknown> | null, index: number): string {
  for (const key of ["label", "name"] as const) {
    const value = option?.[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
  }
  return `Branch ${index + 1}`;
}

/**
 * EVERY branch a choose declares, with the one that ran marked.
 *
 * The branches not taken are the point. A trace that shows only what happened
 * cannot answer "why did it not send the other one", which is the question that
 * brought someone here.
 */
export function chooseOutline(
  step: Record<string, unknown> | null,
  taken: number | "default" | null,
): BranchOutline[] {
  const config = record(step?.config) ?? {};
  const outline: BranchOutline[] = list(config.options).map((option, index) => ({
    option: index,
    label: branchLabel(record(option), index),
    steps: list(record(option)?.sequence).length,
    taken: taken === index,
  }));
  if (config.default != null) {
    outline.push({
      option: "default",
      label: "Otherwise",
      steps: list(config.default).length,
      taken: taken === "default",
    });
  }
  return outline;
}

export type RepeatPlan = {
  /** count | while | until | for_each, or "" when the definition is unreadable. */
  mode: string;
  /** How many passes were expected, when that is knowable up front. */
  planned: number | null;
};

/**
 * What the loop was SUPPOSED to do, so "3 iterations" can be read as short.
 *
 * `count` declares its passes; `for_each` snapshots its list at loop entry and
 * the container's own log carries that length. `while`/`until` are decided one
 * pass at a time and genuinely have no planned total — null, not zero.
 */
export function repeatPlan(step: Record<string, unknown> | null, log: TraceStep): RepeatPlan {
  const config = record(step?.config) ?? {};
  const mode = typeof config.mode === "string" ? config.mode : "";
  if (log.plannedIterations !== null) return { mode, planned: log.plannedIterations };
  const count = Number(config.count);
  return { mode, planned: mode === "count" && Number.isInteger(count) ? count : null };
}

/* ── reading a step log's recorded output ────────────────────────────────── */

/**
 * The per-clause condition results a `condition` step recorded.
 *
 * Null and `[]` are different answers and both are real: null is "this step
 * recorded no clauses" (not a condition, or logged before per-clause results
 * existed), `[]` is "a condition with no clauses", which always passes.
 */
export function parseClauses(output: unknown): ConditionExplanation[] | null {
  const clauses = record(output)?.clauses;
  if (!Array.isArray(clauses)) return null;
  return clauses.flatMap((entry) => {
    const row = record(entry);
    if (!row || typeof row.field !== "string" || typeof row.operator !== "string") return [];
    return [{
      field: row.field,
      operator: row.operator,
      expected: row.expected,
      actual: row.actual,
      passed: row.passed === true,
    }];
  });
}

/** An ISO timestamp written into a step's output, or null. */
export function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A repeat container's snapshotted for_each length, from its own output. */
export function parseItemCount(output: unknown): number | null {
  const items = record(output)?.items;
  return typeof items === "number" && Number.isInteger(items) && items >= 0 ? items : null;
}

/**
 * A condition clause's value in words.
 *
 * `undefined` is the interesting one and the reason this is not `String(value)`:
 * a field the context never carried is the single most common reason a
 * condition surprises someone, and "undefined" reads like a bug in the trace.
 */
export function describeValue(value: unknown): string {
  if (value === undefined) return "not set";
  if (value === null) return "null";
  if (typeof value === "string") return value === "" ? "(empty)" : value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.length === 0 ? "(empty list)" : value.map(describeValue).join(", ").slice(0, 200);
  }
  if (typeof value === "object") return JSON.stringify(value).slice(0, 200);
  return String(value);
}

/** A human operator, e.g. `is_not_empty` → "is not empty". */
export function describeOperator(operator: string): string {
  return operator.replaceAll("_", " ");
}
