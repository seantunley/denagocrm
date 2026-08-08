import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  JOURNEY_LIMITS,
  parseJourneyDefinition,
  parseJourneySequence,
  type JourneyDefinition,
} from "../src/lib/journeyTypes";
import {
  cursorPath,
  flatCursor,
  parseCursor,
  repeatVars,
  withRepeatVars,
  type JourneyCursor,
} from "../src/lib/journeyCursor";
import {
  JourneyScriptCache,
  advanceCursor,
  chooseBranch,
  enterChoose,
  enterRepeat,
  pushFrame,
  resolveCursor,
  type ScriptLookup,
} from "../src/lib/journeyScript";
import {
  AbortJourney,
  ConditionFailed,
  StopJourney,
  isControlFlow,
} from "../src/lib/journeyControlFlow";
import {
  conditionStepOutcome,
  resolveTopLevelNext,
  stopStepOutcome,
} from "../src/lib/journeyStepControl";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * The nested-flow engine: choose, repeat, hierarchical trace paths, lazy branch
 * preparation and raised control flow.
 *
 * Almost everything here is BEHAVIOURAL. `drive()` below is the runner's step
 * loop with the database removed — the same parse, the same cursor primitives,
 * in the same order — so these tests exercise the real traversal rather than
 * reading the source and hoping.
 */

type DriveResult = {
  /** Hierarchical trace path of every LEAF step executed, in order. */
  paths: string[];
  /** Step ids, in order. A repeat legitimately repeats them. */
  executed: string[];
  /** How the run ended: "end" | "stop" | "condition" | "budget". */
  ended: string;
  note: string;
  cursor: JourneyCursor;
  cache: JourneyScriptCache;
  /** repeat.index seen by each leaf, for loop-variable assertions. */
  repeatIndexes: (number | null)[];
};

/**
 * The runner's step loop with the database taken out.
 *
 * Deliberately uses `{ deep: false }` — the same shallow parse processOneRun
 * uses — so the lazy-preparation assertions below are measuring the production
 * path, not a test-only shortcut.
 */
function drive(
  raw: unknown,
  context: Record<string, unknown> = {},
  opts: {
    start?: JourneyCursor;
    cache?: JourneyScriptCache;
    maxSteps?: number;
    /**
     * Step ids that return `{ status: "waiting", retryStep: true }` the FIRST
     * time they are reached — what quiet hours and the frequency cap do to a
     * marketing send. The runner parks WITHOUT advancing the cursor, so the
     * same step runs again on the next tick; this models that by not advancing.
     */
    deferOnce?: Set<string>;
  } = {},
): DriveResult {
  const definition: JourneyDefinition = parseJourneyDefinition(raw, { deep: false });
  const cache = opts.cache ?? new JourneyScriptCache();
  const lookup: ScriptLookup = { cache, versionId: "version-1" };
  let cursor = opts.start ?? flatCursor(definition.startStepId);

  const paths: string[] = [];
  const executed: string[] = [];
  const repeatIndexes: (number | null)[] = [];
  const deferring = new Set(opts.deferOnce ?? []);
  const limit = opts.maxSteps ?? 400;

  for (let i = 0; i < limit; i++) {
    const position = resolveCursor(definition, cursor, lookup);
    if (!position) return { paths, executed, ended: "end", note: "", cursor, cache, repeatIndexes };
    const { step, path: tracePath, keyPath } = position;
    const inSequence = cursor.frames.length > 0;
    const stepContext = withRepeatVars(context, cursor);

    if (step.type === "choose" || step.type === "repeat") {
      const frame =
        step.type === "choose"
          ? (() => {
              const picked = chooseBranch(step, keyPath, stepContext, lookup);
              return picked ? enterChoose(step, picked.option) : null;
            })()
          : enterRepeat(step, keyPath, stepContext, lookup);
      cursor = frame
        ? pushFrame(cursor, frame)
        : advanceCursor({ definition, cursor, context: stepContext, lookup });
      continue;
    }

    paths.push(tracePath);
    executed.push(step.id);
    repeatIndexes.push((repeatVars(cursor)?.index as number) ?? null);

    // A step that could not run yet. The runner parks here WITHOUT advancing,
    // so the very same position is re-entered next tick.
    if (deferring.has(step.id)) {
      deferring.delete(step.id);
      continue;
    }

    let override: { stepId: string | null } | undefined;
    try {
      if (step.type === "stop") stopStepOutcome(step);
      if (step.type === "condition") {
        override = conditionStepOutcome(step, stepContext, inSequence).branch;
      }
    } catch (error) {
      if (error instanceof StopJourney) {
        return { paths, executed, ended: "stop", note: error.message, cursor, cache, repeatIndexes };
      }
      if (error instanceof ConditionFailed) {
        return { paths, executed, ended: "condition", note: error.message, cursor, cache, repeatIndexes };
      }
      throw error;
    }

    cursor = advanceCursor({
      definition,
      cursor,
      context: stepContext,
      lookup,
      ...(override ? { override: override.stepId } : {}),
    });
  }
  return { paths, executed, ended: "budget", note: "", cursor, cache, repeatIndexes };
}

const step = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "send_push",
  config: { message: id },
  ...extra,
});

/* ── 1. trace paths ──────────────────────────────────────────────────────── */

test("a flat journey's trace path is still exactly its step id", () => {
  // The compatibility guarantee the whole migration rests on: every
  // JourneyStepLog row written before nesting existed backfills to path =
  // stepId, and it must be the value the runner would now write for the same
  // step. If this ever stops holding, the backfill silently rewrites history.
  assert.equal(cursorPath(flatCursor("welcome")), "welcome");
  assert.equal(cursorPath(parseCursor(null, "welcome")), "welcome");

  const run = drive({
    startStepId: "a",
    steps: [step("a", { nextStepId: "b" }), step("b", { nextStepId: null })],
  });
  assert.deepEqual(run.paths, ["a", "b"]);
});

test("the same step in a repeat's third iteration is distinguishable from its first", () => {
  // The reported defect, verbatim. With flat step ids, `send` executed three
  // times produced ONE identity — and, through an upsert keyed on it, one row.
  const run = drive({
    startStepId: "loop",
    steps: [
      {
        id: "loop",
        type: "repeat",
        nextStepId: null,
        config: { mode: "count", count: 3, sequence: [step("send"), step("log")] },
      },
    ],
  });

  assert.deepEqual(run.executed, ["send", "log", "send", "log", "send", "log"]);
  assert.deepEqual(run.paths, [
    "loop/repeat/0/sequence/0",
    "loop/repeat/0/sequence/1",
    "loop/repeat/1/sequence/0",
    "loop/repeat/1/sequence/1",
    "loop/repeat/2/sequence/0",
    "loop/repeat/2/sequence/1",
  ]);
  assert.equal(new Set(run.paths).size, 6, "six executions must have six identities");
  assert.equal(new Set(run.executed).size, 2, "…while still being only two steps");
});

test("the step log's uniqueness moved off stepId, which repeat broke", () => {
  // Schema-level, because this is the constraint that could not hold.
  // shipped(): the doc comment above the column NAMES the old constraint to
  // explain why it went, and a raw scan would match its own explanation.
  const schema = shipped("prisma/journeys.prisma");
  assert.match(schema, /@@unique\(\[runId, path\]\)/);
  assert.doesNotMatch(schema, /@@unique\(\[runId, stepId\]\)/);
  const migration = src("prisma/migrations/20260803090000_journey_nested_flow/migration.sql");
  assert.match(migration, /UPDATE "JourneyStepLog" SET "path" = "stepId"/, "existing rows must backfill");
  assert.match(migration, /DROP INDEX IF EXISTS "JourneyStepLog_runId_stepId_key"/);
});

/* ── 2. choose ───────────────────────────────────────────────────────────── */

const chooseJourney = {
  startStepId: "triage",
  steps: [
    {
      id: "triage",
      type: "choose",
      nextStepId: "after",
      config: {
        options: [
          {
            conditions: { logic: "and", conditions: [{ field: "lead.source", operator: "equals", value: "facebook" }] },
            sequence: [step("fb")],
          },
          {
            conditions: { logic: "and", conditions: [{ field: "lead.source", operator: "equals", value: "website" }] },
            sequence: [step("web")],
          },
        ],
        default: [step("other")],
      },
    },
    step("after", { nextStepId: null }),
  ],
};

test("choose takes the FIRST matching branch, then continues after the choose", () => {
  const run = drive(chooseJourney, { lead: { source: "website" } });
  assert.deepEqual(run.executed, ["web", "after"]);
  assert.deepEqual(run.paths, ["triage/choose/1/sequence/0", "after"]);
});

test("choose falls to its default when nothing matches", () => {
  const run = drive(chooseJourney, { lead: { source: "walk-in" } });
  assert.deepEqual(run.executed, ["other", "after"]);
  assert.equal(run.paths[0], "triage/choose/default/sequence/0");
});

test("choose with no match and no default falls through to nextStepId", () => {
  const noDefault = {
    startStepId: "triage",
    steps: [
      {
        id: "triage",
        type: "choose",
        nextStepId: "after",
        config: {
          options: [{
            conditions: { logic: "and", conditions: [{ field: "lead.source", operator: "equals", value: "facebook" }] },
            sequence: [step("fb")],
          }],
        },
      },
      step("after", { nextStepId: null }),
    ],
  };
  const run = drive(noDefault, { lead: { source: "walk-in" } });
  assert.deepEqual(run.executed, ["after"], "an unmatched choose must not stall the run");
});

/* ── 3. lazy sub-script preparation ──────────────────────────────────────── */

function tenBranchChoose(matchOn: string) {
  return {
    startStepId: "big",
    steps: [
      {
        id: "big",
        type: "choose",
        nextStepId: null,
        config: {
          options: Array.from({ length: 10 }, (_, i) => ({
            conditions: { logic: "and", conditions: [{ field: "lead.source", operator: "equals", value: `s${i}` }] },
            sequence: [step(`branch_${i}`)],
          })),
        },
      },
    ],
    matchOn,
  };
}

test("a choose with ten branches prepares ONE branch, not ten", () => {
  // Requirement 3, measured. processOneRun re-parses the definition on every
  // tick for every run; validating ten sequences to execute one of them is work
  // nobody asked for, and it scales with enrolled people.
  const journey = tenBranchChoose("s3");
  const run = drive(journey, { lead: { source: "s3" } });
  assert.deepEqual(run.executed, ["branch_3"]);

  const keys = run.cache.preparedKeys.map((key) => key.replace("version-1#", ""));
  // Conditions are cheap and are tested IN ORDER, so 0..3 are parsed and the
  // rest are never touched.
  assert.deepEqual(
    keys.filter((k) => k.endsWith("/conditions")),
    ["big/choose/0/conditions", "big/choose/1/conditions", "big/choose/2/conditions", "big/choose/3/conditions"],
  );
  // The expensive half: only the winning branch's SEQUENCE is ever prepared.
  assert.deepEqual(keys.filter((k) => k.endsWith("/sequence")), ["big/choose/3/sequence"]);
});

test("a repeat's body is prepared ONCE, not once per iteration", () => {
  // The cache path is iteration-free on purpose. Keying prepared branches by the
  // trace path — which carries the iteration precisely so iterations are
  // distinguishable — would re-validate the body on every pass and quietly undo
  // the laziness.
  const run = drive({
    startStepId: "loop",
    steps: [{
      id: "loop",
      type: "repeat",
      nextStepId: null,
      config: { mode: "count", count: 40, sequence: [step("send")] },
    }],
  });
  assert.equal(run.executed.length, 40);
  const bodyKeys = run.cache.preparedKeys.filter((key) => key.endsWith("/repeat/sequence"));
  assert.deepEqual(bodyKeys, ["version-1#loop/repeat/sequence"], "40 passes, one preparation");
});

test("preparation is memoised, so a second entry costs nothing", () => {
  const cache = new JourneyScriptCache();
  const journey = tenBranchChoose("s0");
  drive(journey, { lead: { source: "s0" } }, { cache });
  const first = cache.size;
  drive(journey, { lead: { source: "s0" } }, { cache });
  assert.equal(cache.size, first, "re-running the same version must not rebuild anything");
});

/* ── 4. repeat modes ─────────────────────────────────────────────────────── */

test("repeat count runs exactly count passes and publishes a 1-based index", () => {
  const run = drive({
    startStepId: "loop",
    steps: [{
      id: "loop",
      type: "repeat",
      nextStepId: "done",
      config: { mode: "count", count: 3, sequence: [step("send")] },
    }, step("done", { nextStepId: null })],
  });
  assert.deepEqual(run.executed, ["send", "send", "send", "done"]);
  // 1-based; null once the loop is left.
  assert.deepEqual(run.repeatIndexes, [1, 2, 3, null]);
});

test("repeat for_each iterates a context list and exposes the item", () => {
  const run = drive(
    {
      startStepId: "loop",
      steps: [{
        id: "loop",
        type: "repeat",
        nextStepId: null,
        config: {
          mode: "for_each",
          itemsPath: "contact.tags",
          sequence: [{
            id: "gate",
            type: "condition",
            config: { condition: { logic: "and", conditions: [{ field: "repeat.item", operator: "not_equals", value: "skip" }] } },
          }],
        },
      }],
    },
    { contact: { tags: ["a", "b"] } },
  );
  assert.deepEqual(run.executed, ["gate", "gate"]);
  assert.deepEqual(run.repeatIndexes, [1, 2]);
});

test("for_each SNAPSHOTS its list, so a parked loop is not re-cut mid-flight", () => {
  // A run can sit inside this loop for days. Re-resolving `contact.tags` on pass
  // four would iterate a list that has since changed length — the loop would
  // either skip items or run off its own end.
  const journey = {
    startStepId: "loop",
    steps: [{
      id: "loop",
      type: "repeat",
      nextStepId: null,
      config: { mode: "for_each", itemsPath: "contact.tags", sequence: [step("send")] },
    }],
  };
  const context: Record<string, unknown> = { contact: { tags: ["a", "b", "c"] } };
  // Two driver steps: entering the repeat, then the first pass of the body.
  const first = drive(journey, context, { maxSteps: 2 });
  assert.equal(first.executed.length, 1);
  const frame = first.cursor.frames[0];
  assert.equal(frame.kind, "repeat");
  assert.deepEqual(frame.kind === "repeat" ? frame.items : null, ["a", "b", "c"]);

  // The contact loses two tags while the run is parked.
  context.contact = { tags: ["a"] };
  const resumed = drive(journey, context, { start: first.cursor });
  assert.equal(resumed.executed.length, 2, "the remaining two passes still run");
});

test("repeat while is checked BEFORE the body; until always runs it once", () => {
  const body = [step("send")];
  const never = { logic: "and", conditions: [{ field: "lead.status", operator: "equals", value: "nope" }] };

  const whileRun = drive({
    startStepId: "loop",
    steps: [
      { id: "loop", type: "repeat", nextStepId: "done", config: { mode: "while", while: never, sequence: body } },
      step("done", { nextStepId: null }),
    ],
  }, { lead: { status: "open" } });
  assert.deepEqual(whileRun.executed, ["done"], "a while that is false at entry must not run the body");

  const untilRun = drive({
    startStepId: "loop",
    steps: [
      { id: "loop", type: "repeat", nextStepId: "done", config: { mode: "until", until: { logic: "and", conditions: [{ field: "lead.status", operator: "equals", value: "open" }] }, sequence: body } },
      step("done", { nextStepId: null }),
    ],
  }, { lead: { status: "open" } });
  assert.deepEqual(untilRun.executed, ["send", "done"], "until is a do-until: one pass, then the check");
});

test("a while that never goes false ABORTS instead of spinning forever", () => {
  // The classic infinite automation. It has to end with a message naming the
  // loop, not with a cron that never returns.
  assert.throws(
    () => drive({
      startStepId: "loop",
      steps: [{
        id: "loop",
        type: "repeat",
        nextStepId: null,
        config: {
          mode: "while",
          while: { logic: "and", conditions: [{ field: "lead.status", operator: "equals", value: "open" }] },
          sequence: [step("send")],
        },
      }],
    }, { lead: { status: "open" } }),
    (error: unknown) =>
      error instanceof AbortJourney &&
      new RegExp(`Repeat loop exceeded ${JOURNEY_LIMITS.repeatIterations} iterations`).test((error as Error).message),
  );
});

/* ── 5. resuming a parked run ────────────────────────────────────────────── */

test("a run parked mid-repeat resumes where it stopped, in a fresh process", () => {
  // The whole justification for a path cursor over a Python-style call stack.
  // Everything in-memory is thrown away here: a new cache, a new parse of the
  // definition, and a cursor that has been through JSON — which is all a
  // different cron process three days later would have.
  const journey = {
    startStepId: "loop",
    steps: [
      {
        id: "loop",
        type: "repeat",
        nextStepId: "done",
        config: {
          mode: "count",
          count: 3,
          sequence: [
            step("one"),
            {
              id: "inner",
              type: "choose",
              config: {
                options: [{
                  conditions: { logic: "and", conditions: [{ field: "lead.source", operator: "equals", value: "web" }] },
                  sequence: [step("two")],
                }],
              },
            },
          ],
        },
      },
      step("done", { nextStepId: null }),
    ],
  };
  const context = { lead: { source: "web" } };

  const whole = drive(journey, context);
  assert.deepEqual(whole.executed, ["one", "two", "one", "two", "one", "two", "done"]);

  // Stop after four leaf steps — inside iteration 1, inside the nested choose.
  const parked = drive(journey, context, { maxSteps: 5 });
  assert.equal(parked.ended, "budget");
  assert.ok(parked.cursor.frames.length >= 1, "the run must be parked INSIDE the loop");

  // Everything a different process would have: JSON on the wire, nothing else.
  const stored = JSON.parse(JSON.stringify(parked.cursor));
  const restored = parseCursor(stored, stored.stepId);
  const resumed = drive(journey, context, { start: restored, cache: new JourneyScriptCache() });

  assert.deepEqual(
    [...parked.executed, ...resumed.executed],
    whole.executed,
    "interrupted + resumed must equal the uninterrupted run, exactly",
  );
  assert.deepEqual([...parked.paths, ...resumed.paths], whole.paths);
});

test("a cursor from before nesting existed resumes as a flat run", () => {
  // Every run parked on a `wait` across this deploy has cursor = NULL.
  const cursor = parseCursor(null, "b");
  assert.deepEqual(cursor, { stepId: "b", frames: [] });

  const run = drive(
    { startStepId: "a", steps: [step("a", { nextStepId: "b" }), step("b", { nextStepId: null })] },
    {},
    { start: cursor },
  );
  assert.deepEqual(run.executed, ["b"], "it resumes on b, not from the top");
});

test("a corrupt or over-deep cursor degrades to the flat position, not a crash", () => {
  assert.deepEqual(parseCursor({ stepId: "x", frames: "nope" }, "b"), { stepId: "b", frames: [] });
  assert.deepEqual(parseCursor({ stepId: "x", frames: [{ kind: "wat", step: "y", index: 0 }] }, "b"), {
    stepId: "b",
    frames: [],
  });
  const tooDeep = { stepId: "x", frames: Array.from({ length: JOURNEY_LIMITS.depth + 1 }, () => ({ kind: "repeat", step: "y", iteration: 0, index: 0 })) };
  assert.deepEqual(parseCursor(tooDeep, "b"), { stepId: "b", frames: [] });
});

test("a cursor naming a step the definition no longer has aborts cleanly", () => {
  // Versions are immutable, so this means hand-edited JSON — which must abort
  // rather than execute whatever step happens to sit at that index elsewhere.
  const journey = {
    startStepId: "loop",
    steps: [{ id: "loop", type: "repeat", nextStepId: null, config: { mode: "count", count: 2, sequence: [step("send")] } }],
  };
  assert.throws(
    () => drive(journey, {}, {
      start: { stepId: "loop", frames: [{ kind: "repeat", step: "someone_else", iteration: 0, index: 0 }] },
    }),
    AbortJourney,
  );
});

/* ── 6. raised control flow ──────────────────────────────────────────────── */

test("stop is RAISED, and unwinds every enclosing sequence", () => {
  const run = drive({
    startStepId: "loop",
    steps: [
      {
        id: "loop",
        type: "repeat",
        nextStepId: "never",
        config: {
          mode: "count",
          count: 5,
          sequence: [step("send"), { id: "halt", type: "stop", config: { reason: "Enough" } }],
        },
      },
      step("never", { nextStepId: null }),
    ],
  });
  assert.equal(run.ended, "stop");
  assert.equal(run.note, "Enough");
  assert.deepEqual(run.executed, ["send", "halt"], "one pass, then out of the loop entirely");
});

test("stop with error: true aborts instead of completing", () => {
  // `error: true` must fail the run WITHOUT retrying — an
  // author-declared stop is deterministic, so three attempts fail three times.
  assert.throws(
    () => stopStepOutcome({ id: "s", type: "stop", config: { error: true, reason: "Bad data" } }),
    (error: unknown) => error instanceof AbortJourney && (error as Error).message === "Bad data",
  );
  assert.throws(
    () => stopStepOutcome({ id: "s", type: "stop", config: { reason: "Done" } }),
    (error: unknown) => error instanceof StopJourney && (error as Error).message === "Done",
  );
});

test("a bare condition inside a sequence is a GATE, and failing it ends the run", () => {
  const gate = {
    id: "gate",
    type: "condition",
    config: { condition: { logic: "and", conditions: [{ field: "contact.hasVehicle", operator: "equals", value: true }] } },
  };
  const journey = {
    startStepId: "branch",
    steps: [
      {
        id: "branch",
        type: "choose",
        nextStepId: "after",
        config: { options: [{ sequence: [gate, step("send")] }] },
      },
      step("after", { nextStepId: null }),
    ],
  };
  const passed = drive(journey, { contact: { hasVehicle: true } });
  assert.deepEqual(passed.executed, ["gate", "send", "after"]);

  const failed = drive(journey, { contact: { hasVehicle: false } });
  assert.equal(failed.ended, "condition");
  assert.deepEqual(failed.executed, ["gate"], "the rest of the run must not proceed");
});

test("a TOP-LEVEL condition still branches two ways — existing journeys are untouched", () => {
  const conditionStep = {
    id: "branch",
    type: "condition" as const,
    nextStepId: "fallthrough",
    config: {
      condition: { logic: "and", conditions: [{ field: "lead.source", operator: "equals", value: "web" }] },
      trueStepId: "yes",
      falseStepId: "no",
    },
  };
  const yes = conditionStepOutcome(conditionStep, { lead: { source: "web" } }, false);
  assert.deepEqual(yes.branch, { stepId: "yes" });
  assert.equal(yes.output.passed, true);
  assert.equal((yes.output.clauses as unknown[]).length, 1, "the per-clause trace must survive");

  const no = conditionStepOutcome(conditionStep, { lead: { source: "walk-in" } }, false);
  assert.deepEqual(no.branch, { stepId: "no" });
});

test("'no successor' and 'the author stopped it' are no longer the same value", () => {
  // The creak this replaced: `nextStepId` carried three meanings on one field —
  // absent, null and a string — and `stop` used the same `null` a branch with no
  // successor produced.
  const withNext = { id: "a", type: "send_push" as const, nextStepId: "b", config: {} };
  assert.equal(resolveTopLevelNext(withNext, {}), "b", "absent branch = fall through");
  assert.equal(
    resolveTopLevelNext(withNext, { branch: { stepId: null } }),
    null,
    "an EXPLICIT null branch must beat the step's own nextStepId",
  );
  assert.equal(resolveTopLevelNext(withNext, { branch: { stepId: "c" } }), "c");
});

test("control flow is a distinct class from a fault", () => {
  // What continueOnError keys off. Swallowing a stop or a gate would run the
  // steps the author deliberately put behind them.
  assert.equal(isControlFlow(new StopJourney("x")), true);
  assert.equal(isControlFlow(new ConditionFailed()), true);
  assert.equal(isControlFlow(new AbortJourney("x")), true);
  assert.equal(isControlFlow(new Error("SMS provider 503")), false);
});

test("continueOnError swallows faults only, and is round-tripped by the parser", () => {
  const parsed = parseJourneyDefinition({
    startStepId: "sms",
    steps: [{ id: "sms", type: "send_sms", continueOnError: true, nextStepId: null, config: { message: "hi" } }],
  });
  assert.equal(parsed.steps[0].continueOnError, true, "a dropped flag silently re-arms the old behaviour");

  // The guard itself is one expression in the runner, and inverting it is the
  // bug: a swallowed stop runs the steps the author put behind it.
  assert.match(
    shipped("src/lib/journeyRuns.ts"),
    /if \(isControlFlow\(error\) \|\| !step\.continueOnError\) throw error;/,
    "control flow must never be treated as a recoverable fault",
  );
});

/* ── 7. what replaced the visited-set cycle detector ─────────────────────── */

test("the per-tick visited Set is gone — a repeat is not a cycle", () => {
  const runs = shipped("src/lib/journeyRuns.ts");
  assert.doesNotMatch(runs, /const visited = new Set/, "a repeat revisits step ids by design");
  assert.doesNotMatch(runs, /Journey cycle detected/);

  // Behavioural half: forty visits to the same step id, no error.
  const run = drive({
    startStepId: "loop",
    steps: [{ id: "loop", type: "repeat", nextStepId: null, config: { mode: "count", count: 40, sequence: [step("send")] } }],
  });
  assert.equal(run.executed.length, 40);
  assert.equal(new Set(run.executed).size, 1);
});

/* ── 8. limits ───────────────────────────────────────────────────────────── */

test("the step ceiling counts NESTED steps, which is what nesting broke", () => {
  // The old cap counted the flat array. Fifty top-level chooses with ten
  // branches each would have passed a 50-step check while carrying 500 actions.
  const fat = {
    startStepId: "loop",
    steps: [{
      id: "loop",
      type: "repeat",
      nextStepId: null,
      config: {
        mode: "count",
        count: 1,
        sequence: Array.from({ length: JOURNEY_LIMITS.steps }, (_, i) => step(`s${i}`)),
      },
    }],
  };
  assert.throws(() => parseJourneyDefinition(fat), new RegExp(`at most ${JOURNEY_LIMITS.steps} steps`));
});

test("nesting deeper than the cap is rejected — the cursor stack has to fit", () => {
  let config: Record<string, unknown> = { mode: "count", count: 1, sequence: [step("leaf")] };
  for (let depth = 0; depth < JOURNEY_LIMITS.depth; depth++) {
    config = { mode: "count", count: 1, sequence: [{ id: `r${depth}`, type: "repeat", config }] };
  }
  assert.throws(
    () => parseJourneyDefinition({ startStepId: "top", steps: [{ id: "top", type: "repeat", config }] }),
    new RegExp(`nested more than ${JOURNEY_LIMITS.depth} levels deep`),
  );
});

test("a choose may not become a lookup table", () => {
  assert.throws(
    () => parseJourneyDefinition({
      startStepId: "big",
      steps: [{
        id: "big",
        type: "choose",
        config: { options: Array.from({ length: JOURNEY_LIMITS.chooseOptions + 1 }, (_, i) => ({ sequence: [step(`b${i}`)] })) },
      }],
    }),
    new RegExp(`at most ${JOURNEY_LIMITS.chooseOptions} options`),
  );
});

test("the definitions that would never terminate are refused at save time", () => {
  const build = (config: Record<string, unknown>) => ({
    startStepId: "loop",
    steps: [{ id: "loop", type: "repeat", config }],
  });
  // A while with no clauses evaluates TRUE — an infinite loop that only the
  // iteration ceiling would stop, hours later, having sent 100 messages.
  assert.throws(
    () => parseJourneyDefinition(build({ mode: "while", while: { logic: "and", conditions: [] }, sequence: [step("s")] })),
    /never ends/,
  );
  assert.throws(
    () => parseJourneyDefinition(build({ mode: "count", count: JOURNEY_LIMITS.repeatIterations + 1, sequence: [step("s")] })),
    new RegExp(`between 1 and ${JOURNEY_LIMITS.repeatIterations}`),
  );
  assert.throws(() => parseJourneyDefinition(build({ mode: "spin", sequence: [step("s")] })), /Unsupported repeat mode/);
  assert.throws(() => parseJourneyDefinition(build({ mode: "for_each", sequence: [step("s")] })), /needs items or itemsPath/);
  assert.throws(
    () => parseJourneyDefinition(build({ mode: "for_each", itemsPath: "../../etc", sequence: [step("s")] })),
    /Unsafe for_each itemsPath/,
  );
  assert.throws(
    () => parseJourneyDefinition(build({ mode: "count", count: 1, sequence: [] })),
    /at least one step/,
    "an empty sequence would leave the cursor pointing at nothing",
  );
});

test("a nested step may not jump to a top-level id", () => {
  // It would abandon the very cursor frames that make the enclosing loop
  // resumable — and the parser is the only place that mistake is cheap.
  assert.throws(
    () => parseJourneyDefinition({
      startStepId: "loop",
      steps: [
        { id: "loop", type: "repeat", nextStepId: "after", config: { mode: "count", count: 1, sequence: [step("inner", { nextStepId: "after" })] } },
        step("after", { nextStepId: null }),
      ],
    }),
    /may not set nextStepId/,
  );
  assert.throws(
    () => parseJourneyDefinition({
      startStepId: "loop",
      steps: [
        {
          id: "loop",
          type: "repeat",
          nextStepId: "after",
          config: {
            mode: "count",
            count: 1,
            sequence: [{ id: "gate", type: "condition", config: { condition: { logic: "and", conditions: [] }, trueStepId: "after" } }],
          },
        },
        step("after", { nextStepId: null }),
      ],
    }),
    /use choose for branching/,
  );
});

test("shallow parsing skips nested branches — and deep parsing does not", () => {
  // The two halves of lazy preparation. The runner must not pay for branches it
  // will not run; save and publish must still refuse a broken one.
  const broken = {
    startStepId: "big",
    steps: [{
      id: "big",
      type: "choose",
      nextStepId: null,
      config: { options: [{ sequence: [{ id: "bad", type: "run_arbitrary_code", config: {} }] }] },
    }],
  };
  assert.doesNotThrow(() => parseJourneyDefinition(broken, { deep: false }));
  assert.throws(() => parseJourneyDefinition(broken), /Unsupported journey step/);
  // …and the runner still refuses it, on entry, when the branch is prepared.
  assert.throws(() => parseJourneySequence(broken.steps[0].config.options[0].sequence), /Unsupported journey step/);
});

test("save and publish use the DEEP parse; the runner uses the shallow one", () => {
  assert.match(
    shipped("src/lib/journeyRuns.ts"),
    /parseJourneyDefinition\(run\.journeyVersion\.definition, \{ deep: false \}\)/,
  );
  const actions = shipped("src/app/actions/journeys.ts");
  assert.match(actions, /parseJourneyDefinition\(rawDefinition\)/, "saving must validate everything");
  assert.match(actions, /parseJourneyDefinition\(draft\.definition\)/, "so must publishing");
});

/* ── 9. the builder round-trips what it cannot edit ──────────────────────── */

test("the builder carries choose/repeat through instead of dropping them", () => {
  // There is no visual editor for these yet. Silently dropping the branches on
  // save would destroy work with no error and no undo, so the builder preserves
  // the config verbatim and locks the type selector.
  const builder = shipped("src/components/JourneyBuilder.tsx");
  // `wait_for_trigger` and `variables` joined the set for the same reason — see
  // tests/journeyWaitVariables.test.ts. What matters here is that choose and
  // repeat are still in it.
  assert.match(builder, /READ_ONLY_STEP_TYPES = new Set\(\[[^\]]*"choose"[^\]]*"repeat"[^\]]*\]\)/);
  assert.match(
    builder,
    /if \(READ_ONLY_STEP_TYPES\.has\(step\.type\)\) \{\s*return \{ id: step\.id, type: step\.type, continueOnError: step\.continueOnError, config \};/,
    "a container's config must be carried through untouched",
  );
  assert.match(builder, /disabled=\{READ_ONLY_STEP_TYPES\.has\(step\.type\)\}/, "the type selector must be locked");
  assert.match(builder, /no visual editor for this step yet/i, "…and it must SAY so on screen");
  assert.match(builder, /continueOnError: step\.continueOnError/);
});

/* ── 10. a step that could not run yet is retried, not skipped ───────────── */

test("a marketing send held by quiet hours is retried IN PLACE, even inside a repeat", () => {
  // Found while rebasing this branch onto a main that had gained the consent
  // gate. Two different things share `status: "waiting"`: a `wait` step
  // SUCCEEDED — pausing is the job — so the run resumes after it; a send held
  // by quiet hours or a frequency cap did NOT run and still has to go out.
  //
  // The old encoding for "retry me" was `nextStepId: step.id`, which became a
  // branch override. That works at the top level and QUIETLY FAILS inside a
  // container: advanceCursor honours `override` only when there are no frames,
  // and otherwise steps the frame index on regardless. So a marketing email in
  // a loop would be advanced past and never sent — the same silent-suppression
  // failure the consent-gate fix existed to close.
  const definition = {
    startStepId: "loop",
    steps: [
      {
        id: "loop",
        type: "repeat",
        config: {
          mode: "count",
          count: 1,
          sequence: [step("email", { nextStepId: null }), step("sms", { nextStepId: null })],
        },
        nextStepId: null,
      },
    ],
  };

  const held = drive(definition, {}, { deferOnce: new Set(["email"]) });
  // "email" appears TWICE: the attempt that was held, then the one that sends.
  assert.deepEqual(
    held.executed,
    ["email", "email", "sms"],
    "the held send must be retried in place, not skipped",
  );
  // Same iteration, so the same trace path — the step-log upsert is keyed on it
  // and the real attempt overwrites the held one rather than adding a row.
  assert.equal(held.paths[0], held.paths[1]);

  // And the position it resumes from is the step itself, not the one after it.
  const undeferred = drive(definition);
  assert.deepEqual(undeferred.executed, ["email", "sms"]);
  assert.deepEqual(held.paths.slice(1), undeferred.paths);
});

test("the runner does not advance the cursor when a step asks to be retried", () => {
  // The behavioural test above drives a model of the loop; this pins the real
  // runner, because the model is only faithful if the guard is actually there.
  const runner = shipped("src/lib/journeyRuns.ts");
  assert.match(
    runner,
    /if \(!\(result\.status === "waiting" && result\.retryStep\)\) \{\s*cursor = advanceCursor\(/,
    "a retry-in-place must skip advanceCursor entirely",
  );
  // And the executor must actually set the flag on both held sends.
  const executor = shipped("src/lib/journeyStepExecutor.ts");
  assert.equal(
    (executor.match(/retryStep: true/g) ?? []).length,
    2,
    "both the email and the SMS consent defers must ask to be retried",
  );
  assert.ok(
    !/nextStepId: step\.id/.test(executor),
    "the old branch-override spelling silently fails inside a container",
  );
});

/* ── 11. the ceiling must not reject the documented maximum ──────────────── */

test("a repeat of exactly the maximum count completes instead of failing", () => {
  // The ceiling was checked BEFORE asking whether the loop had finished. With
  // `count: 100` the passes are iterations 0…99, so after the last one `next`
  // is 100 — and a loop that had just done exactly what the author asked was
  // aborted as a runaway and its run marked failed. JOURNEY_LIMITS caps
  // repeatIterations at 100 and the parser accepts count: 100, so the limit and
  // the validator disagreed about what "100 iterations" means.
  const max = JOURNEY_LIMITS.repeatIterations;
  const run = drive({
    startStepId: "loop",
    steps: [
      {
        id: "loop",
        type: "repeat",
        nextStepId: "after",
        config: { mode: "count", count: max, sequence: [step("tick")] },
      },
      step("after", { nextStepId: null }),
    ],
  }, {}, { maxSteps: max * 4 });

  assert.equal(run.ended, "end", `a full-length repeat must finish, not ${run.ended}`);
  assert.equal(
    run.executed.filter((id) => id === "tick").length,
    max,
    "every requested pass must run",
  );
  // …and the step AFTER the loop must be reached, which is what "completes"
  // actually means to the person who wrote the journey.
  assert.equal(run.executed[run.executed.length - 1], "after");
});

test("a for_each over the maximum item count completes too", () => {
  // Same defect, reached through the other bounded mode: forEachItems is capped
  // at 100 as well, so the largest legal list was also the one that failed.
  const max = JOURNEY_LIMITS.forEachItems;
  const items = Array.from({ length: max }, (_, i) => `item-${i}`);
  const run = drive({
    startStepId: "loop",
    steps: [
      {
        id: "loop",
        type: "repeat",
        nextStepId: null,
        config: { mode: "for_each", itemsPath: "list", sequence: [step("tick")] },
      },
    ],
  }, { list: items }, { maxSteps: max * 4 });

  assert.equal(run.ended, "end");
  assert.equal(run.executed.filter((id) => id === "tick").length, max);
});

test("a runaway while still hits the ceiling", () => {
  // The ceiling moved, it did not go away. A condition that never goes false is
  // the case it exists for, and it must still abort rather than spin.
  assert.throws(
    () =>
      drive({
        startStepId: "loop",
        steps: [
          {
            id: "loop",
            type: "repeat",
            nextStepId: null,
            config: {
              mode: "while",
              conditions: { all: [{ field: "lead.id", operator: "is_not_empty" }] },
              sequence: [step("tick")],
            },
          },
        ],
      }, { lead: { id: "lead-1" } }, { maxSteps: 5000 }),
    /exceeded 100 iterations/,
    "an endless while must abort at the ceiling",
  );
});

/* ── 12. a top-level back-edge cannot be traced, so it is refused ────────── */

test("a top-level back-edge is refused, and says to use repeat", () => {
  // A top-level step's trace path is exactly its id, and JourneyStepLog is
  // upserted on (runId, path) — so a second visit silently OVERWRITES the
  // first. The activity trace, whose whole job is showing what happened, would
  // show only the latest pass with no sign the earlier ones existed.
  //
  // Nothing bounded it either: the per-tick `visited` Set that used to catch
  // this was removed (a repeat revisits ids by design, so it called every
  // legitimate loop a cycle) and it never caught the real case anyway, because
  // rebuilding it per tick meant a back-edge with a `wait` in it went round
  // forever and was never seen twice. A static check catches exactly that.
  assert.throws(
    () =>
      parseJourneyDefinition({
        startStepId: "a",
        steps: [step("a", { nextStepId: "b" }), step("b", { nextStepId: "a" })],
      }),
    /loops back to a[\s\S]*repeat step/,
    "a two-step loop must be refused with advice, not accepted",
  );
});

test("a condition branching backwards is a back-edge too", () => {
  // The obvious way to write "keep checking until it's true" by hand, and the
  // one most likely to be reached — trueStepId/falseStepId are jump targets
  // exactly like nextStepId.
  assert.throws(
    () =>
      parseJourneyDefinition({
        startStepId: "gate",
        steps: [
          { id: "gate", type: "condition", nextStepId: null, config: { conditions: { all: [] }, falseStepId: "work" } },
          step("work", { nextStepId: "gate" }),
        ],
      }),
    /loops back to/,
  );
});

test("a step pointing at ITSELF is refused", () => {
  // The degenerate case, and the cheapest one to get wrong in a builder.
  assert.throws(
    () => parseJourneyDefinition({ startStepId: "a", steps: [step("a", { nextStepId: "a" })] }),
    /loops back to a/,
  );
});

test("convergence is NOT a cycle — two branches may meet", () => {
  // The check must refuse back-edges, not any repeated target. Both arms of a
  // condition landing on one follow-up step is ordinary, executes it once, and
  // traces cleanly.
  const definition = parseJourneyDefinition({
    startStepId: "gate",
    steps: [
      {
        id: "gate",
        type: "condition",
        nextStepId: null,
        config: { conditions: { all: [] }, trueStepId: "yes", falseStepId: "no" },
      },
      step("yes", { nextStepId: "done" }),
      step("no", { nextStepId: "done" }),
      step("done", { nextStepId: null }),
    ],
  });
  assert.equal(definition.steps.length, 4);

  // …and it really does execute `done` exactly once, with one trace identity.
  const run = drive(definition as unknown, {});
  assert.equal(run.executed.filter((id) => id === "done").length, 1);
  assert.equal(new Set(run.paths).size, run.paths.length, "every execution keeps its own path");
});

test("a long straight chain is not mistaken for a cycle", () => {
  // Guards the traversal itself: a colour map that never marks nodes done would
  // reject deep-but-acyclic graphs, and this is the shape that catches it.
  const steps = Array.from({ length: 40 }, (_, i) =>
    step(`s${i}`, { nextStepId: i === 39 ? null : `s${i + 1}` }),
  );
  const definition = parseJourneyDefinition({ startStepId: "s0", steps });
  assert.equal(definition.steps.length, 40);
});

/* ── 13. one unreadable definition must not poison the tick ──────────────── */

test("definition AND cursor preparation are inside the per-run error boundary", () => {
  // The run is claimed as "running" before anything is parsed. A throw from
  // preparation escaped processOneRun → processJourneyRuns → runJourneyEngine,
  // so one bad definition stopped every other run in that tenant's tick and
  // left itself claimed until the 15-minute stale sweep — which handed it back
  // to do it again.
  //
  // Refusing top-level cycles (above) is a NEW way to throw here: every journey
  // published while back-edges were permitted now fails this parse. And a
  // published version is IMMUTABLE, so the definition cannot be corrected in
  // place — the run would have poisoned the tick on every retry, forever.
  const runs = shipped("src/lib/journeyRuns.ts");
  // Anchor without the `export` keyword: processOneRun is exported on the
  // run-modes branch and not on this one, and an anchor that misses returns -1,
  // which slices to something that passes every assertion vacuously.
  const start = runs.indexOf("function processOneRun");
  assert.notEqual(start, -1, "processOneRun is gone — was it renamed?");
  const end = runs.indexOf("function processJourneyRuns", start);
  assert.notEqual(end, -1, "processJourneyRuns is gone — was it renamed?");
  const body = runs.slice(start, end);
  assert.ok(body.length > 0, "the slice ran backwards");

  const guard = body.indexOf("try {");
  for (const call of [
    "parseJourneyDefinition(run.journeyVersion.definition",
    "parseCursor(run.cursor, run.currentStepId)",
    "journeyScriptCache()",
  ]) {
    const at = body.indexOf(call);
    assert.notEqual(at, -1, `${call} is gone — was it renamed?`);
    assert.ok(guard !== -1 && guard < at, `${call} must be inside a try, not before one`);
  }

  // Deterministically failed, not retried: the version is immutable, so a
  // definition that will not parse now will not parse on the third attempt.
  assert.match(
    body.slice(guard),
    /status: "failed",[\s\S]*?Definition could not be read/,
    "an unreadable definition must fail its own run with a reason",
  );
  assert.ok(
    !/status: retry \? "queued" : "failed"[\s\S]{0,200}Definition could not be read/.test(body),
    "preparation failures must not go through the retrying path",
  );
});
