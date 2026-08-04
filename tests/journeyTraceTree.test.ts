import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildTraceTree,
  chooseOutline,
  definitionNodeAt,
  describeValue,
  flattenTrace,
  isHeldStep,
  iterationsToExpand,
  parseClauses,
  parseItemCount,
  parseTimestamp,
  parseTracePath,
  repeatPlan,
  stepOutcome,
  summariseRepeat,
  takenChooseOption,
  type TraceNode,
  type TraceStep,
} from "../src/lib/journeyTraceTree";
import { clauseHeld } from "../src/lib/journeyTypes";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shipped = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * The trace UI's reading of a run's path through the graph.
 *
 * Behavioural throughout, and that is the point: `blast/repeat/2/sequence/1`
 * either resolves to the second step of the third iteration or it silently
 * resolves to a plausible WRONG step, and no amount of reading the source tells
 * you which. Every assertion here drives the real functions.
 */

const T0 = new Date("2026-01-01T08:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function log(path: string, overrides: Partial<TraceStep> = {}): TraceStep {
  return {
    path,
    stepId: path.split("/")[0],
    stepType: "send_email",
    status: "completed",
    note: null,
    startedAt: T0,
    completedAt: at(1),
    durationMs: 1000,
    clauses: null,
    nextRunAt: null,
    plannedIterations: null,
    ...overrides,
  };
}

/** The container rows the engine writes before it pushes a cursor frame. */
function container(path: string, type: "choose" | "repeat", overrides: Partial<TraceStep> = {}) {
  return log(path, { stepType: type, ...overrides });
}

function pathsOf(nodes: TraceNode[]): string[] {
  return flattenTrace(nodes).map((node) => node.step.path);
}

/* ── the path grammar ────────────────────────────────────────────────────── */

test("a flat path is just the step id — every pre-nesting row still reads", () => {
  assert.deepEqual(parseTracePath("welcome"), { stepId: "welcome", segments: [] });
});

test("a path names the branch, the iteration and the position", () => {
  assert.deepEqual(parseTracePath("triage/choose/1/sequence/0"), {
    stepId: "triage",
    segments: [{ kind: "choose", option: 1, index: 0 }],
  });
  assert.deepEqual(parseTracePath("blast/repeat/2/sequence/1"), {
    stepId: "blast",
    segments: [{ kind: "repeat", iteration: 2, index: 1 }],
  });
  assert.deepEqual(parseTracePath("triage/choose/default/sequence/0"), {
    stepId: "triage",
    segments: [{ kind: "choose", option: "default", index: 0 }],
  });
  // Nested: a repeat inside the second branch of a choose.
  assert.deepEqual(parseTracePath("triage/choose/1/sequence/0/repeat/3/sequence/2"), {
    stepId: "triage",
    segments: [
      { kind: "choose", option: 1, index: 0 },
      { kind: "repeat", iteration: 3, index: 2 },
    ],
  });
});

test("a malformed path is REFUSED, not coerced into a position", () => {
  // Number("") is 0 and Number(" 1 ") is 1. Either would place the row under a
  // real branch that it did not run in — the one failure mode a trace must not
  // have, because the reader has no way to tell.
  for (const bad of [
    "",
    "blast/repeat//sequence/1",
    "blast/repeat/ 1 /sequence/0",
    "blast/repeat/-1/sequence/0",
    "blast/repeat/1.5/sequence/0",
    "triage/choose/1/sequence",
    "triage/choose/1/steps/0",
    "triage/loop/1/sequence/0",
    "triage/repeat/default/sequence/0",
    // Deeper than the cursor stack is allowed to be, so it did not come from us.
    "a/repeat/0/sequence/0/repeat/0/sequence/0/repeat/0/sequence/0/repeat/0/sequence/0/repeat/0/sequence/0/repeat/0/sequence/0",
  ]) {
    assert.equal(parseTracePath(bad), null, `should not parse: ${bad}`);
  }
});

/* ── the tree ────────────────────────────────────────────────────────────── */

test("one step id, three iterations, three separate places on screen", () => {
  // The whole reason the schema grew a `path` column. Under the old
  // @@unique([runId, stepId]) these were one row; collapsing them back into one
  // node here would undo the migration in the UI.
  const tree = buildTraceTree([
    container("blast", "repeat", { plannedIterations: 3 }),
    log("blast/repeat/0/sequence/0", { status: "completed" }),
    log("blast/repeat/1/sequence/0", { status: "failed" }),
    log("blast/repeat/2/sequence/0", { status: "completed" }),
  ]);

  assert.equal(tree.length, 1, "the container is the only top-level node");
  const iterations = tree[0].groups;
  assert.equal(iterations.length, 3);
  assert.deepEqual(iterations.map((group) => group.key), [0, 1, 2]);
  assert.deepEqual(
    iterations.map((group) => group.nodes[0].step.status),
    ["completed", "failed", "completed"],
    "each iteration keeps its own outcome",
  );
});

test("a nested child hangs off its container, not off the top level", () => {
  // Option 1 at index 2 on purpose: with the two numbers equal, a segment
  // rebuilt as `choose/<index>/sequence/<option>` produces the identical string
  // and the fixture would pass a parent lookup that had been swapped.
  const tree = buildTraceTree([
    log("welcome"),
    container("triage", "choose"),
    log("triage/choose/1/sequence/0"),
    container("triage/choose/1/sequence/2", "repeat"),
    log("triage/choose/1/sequence/2/repeat/0/sequence/0"),
  ]);

  assert.deepEqual(tree.map((node) => node.step.path), ["welcome", "triage"]);
  const branch = tree[1].groups[0];
  assert.equal(branch.kind, "choose");
  assert.equal(branch.key, 1);
  assert.deepEqual(branch.nodes.map((node) => node.depth), [1, 1]);
  const inner = branch.nodes[1].groups[0];
  assert.equal(inner.kind, "repeat");
  assert.equal(inner.nodes[0].depth, 2);
  assert.equal(inner.nodes[0].step.path, "triage/choose/1/sequence/2/repeat/0/sequence/0");
});

test("NOTHING is dropped — an orphan and an unreadable path still appear", () => {
  // Trace retention purges old step logs, which can leave a child whose
  // container row is gone. A tree that placed children with `map.get(parent)`
  // and skipped the misses would erase a step that genuinely executed.
  const rows = [
    log("welcome"),
    log("blast/repeat/0/sequence/0"), // container row purged
    log("legacy/nonsense/path"), // unparseable
    container("triage", "choose"),
    log("triage/choose/0/sequence/0"),
  ];
  const tree = buildTraceTree(rows);

  const seen = pathsOf(tree);
  assert.equal(seen.length, rows.length, "every row must appear exactly once");
  for (const row of rows) assert.ok(seen.includes(row.path), `${row.path} vanished`);

  const orphan = tree.find((node) => node.step.path === "blast/repeat/0/sequence/0");
  assert.ok(orphan, "the orphan was not promoted to the top level");
  assert.equal(orphan.orphaned, true, "…and must be marked, not passed off as a top-level step");
  const unreadable = tree.find((node) => node.step.path === "legacy/nonsense/path");
  assert.equal(unreadable?.orphaned, false, "an unparseable path has no missing container to blame");
});

test("steps inside a branch are ordered by SEQUENCE position, not the clock", () => {
  // A step held by quiet hours has its startedAt reset when it is finally
  // retried. Ordering the branch by time would jump it to the bottom of a
  // sequence it belongs in the middle of, and the trace would show an order the
  // run never executed.
  const tree = buildTraceTree([
    container("triage", "choose"),
    log("triage/choose/0/sequence/1", { startedAt: at(10) }),
    log("triage/choose/0/sequence/0", { startedAt: at(90) }),
  ]);
  assert.deepEqual(
    tree[0].groups[0].nodes.map((node) => node.step.path),
    ["triage/choose/0/sequence/0", "triage/choose/0/sequence/1"],
  );
});

test("the top level is chronological, because a back-edge revisits a step", () => {
  const tree = buildTraceTree([
    log("nudge", { startedAt: at(60) }),
    log("welcome", { startedAt: at(0) }),
  ]);
  assert.deepEqual(tree.map((node) => node.step.path), ["welcome", "nudge"]);
});

/* ── reading the pinned definition ───────────────────────────────────────── */

const definition = {
  startStepId: "triage",
  steps: [
    {
      id: "triage",
      type: "choose",
      config: {
        options: [
          { label: "High value", conditions: {}, sequence: [{ id: "vip", type: "send_email", config: {} }] },
          {
            conditions: {},
            sequence: [
              { id: "note", type: "create_activity", config: {} },
              {
                id: "blast",
                type: "repeat",
                config: {
                  mode: "count",
                  count: 4,
                  sequence: [
                    { id: "first", type: "send_sms", config: {} },
                    { id: "second", type: "send_email", config: {} },
                  ],
                },
              },
            ],
          },
        ],
        default: [{ id: "fallback", type: "stop", config: {} }],
      },
    },
  ],
};

/** The id of the definition step a path names — null if it resolves to nothing. */
function idAt(path: string): unknown {
  const parsed = parseTracePath(path);
  assert.ok(parsed, `unparseable: ${path}`);
  return definitionNodeAt(definition, parsed)?.id ?? null;
}

test("a repeat path resolves by INDEX in the body, never by iteration", () => {
  // Every pass runs the identical sequence. Indexing by iteration would name a
  // real, plausible step from pass two onwards — and read as an empty body once
  // the iteration number ran past the sequence length.
  assert.equal(idAt("triage/choose/1/sequence/1/repeat/2/sequence/1"), "second");
  assert.equal(
    idAt("triage/choose/1/sequence/1/repeat/0/sequence/1"),
    "second",
    "iteration 0 and iteration 2 execute the same body step",
  );
  assert.equal(idAt("triage/choose/1/sequence/1/repeat/9/sequence/0"), "first");
});

test("a choose path descends the option it names, and the default", () => {
  assert.equal(idAt("triage/choose/0/sequence/0"), "vip");
  assert.equal(idAt("triage/choose/default/sequence/0"), "fallback");
});

test("an unreadable definition returns null rather than throwing", () => {
  // A trace is read precisely when a journey is broken. A screen that 500s on
  // the damaged definition is no use to the person debugging it.
  const parsed = parseTracePath("triage/choose/7/sequence/3");
  assert.ok(parsed);
  assert.equal(definitionNodeAt(definition, parsed), null);
  assert.equal(definitionNodeAt(null, parsed), null);
  assert.equal(definitionNodeAt({ steps: "not a list" }, parsed), null);
});

test("a choose shows the branches it did NOT take", () => {
  // "Why did it not send the other one" is the question that brings someone
  // here, and a trace of only what happened cannot answer it.
  const tree = buildTraceTree([
    container("triage", "choose"),
    log("triage/choose/1/sequence/0"),
  ]);
  const parsed = parseTracePath("triage");
  assert.ok(parsed);
  const outline = chooseOutline(definitionNodeAt(definition, parsed), takenChooseOption(tree[0]));

  assert.deepEqual(outline.map((branch) => branch.option), [0, 1, "default"]);
  assert.deepEqual(outline.map((branch) => branch.taken), [false, true, false]);
  assert.equal(outline[0].label, "High value", "a labelled option keeps its label");
  assert.equal(outline[1].label, "Branch 2", "an unlabelled one is numbered from 1, as a person counts");
  assert.deepEqual(outline.map((branch) => branch.steps), [1, 2, 1]);
});

test("a choose that matched nothing marks every branch not taken", () => {
  const tree = buildTraceTree([container("triage", "choose", { note: "No branch matched" })]);
  assert.equal(takenChooseOption(tree[0]), null);
  const parsed = parseTracePath("triage");
  assert.ok(parsed);
  const outline = chooseOutline(definitionNodeAt(definition, parsed), takenChooseOption(tree[0]));
  assert.equal(outline.length, 3);
  assert.equal(outline.some((branch) => branch.taken), false);
});

test("a repeat says how many passes were PLANNED, and when it cannot know", () => {
  const countNode = definitionNodeAt(definition, parseTracePath("triage/choose/1/sequence/1")!);
  assert.deepEqual(repeatPlan(countNode, log("blast", { stepType: "repeat" })), {
    mode: "count",
    planned: 4,
  });
  // for_each snapshots its list at loop entry and the container's own row
  // carries that length.
  assert.deepEqual(
    repeatPlan({ config: { mode: "for_each" } }, log("blast", { plannedIterations: 7 })),
    { mode: "for_each", planned: 7 },
  );
  // while/until are decided one pass at a time — null, never 0, which would read
  // as "planned to run no times".
  assert.deepEqual(repeatPlan({ config: { mode: "while" } }, log("blast")), {
    mode: "while",
    planned: null,
  });
});

/* ── what a status MEANS ─────────────────────────────────────────────────── */

test("a step held for retry is neither done nor failed", () => {
  // Quiet hours. The runner writes status "running" with a nextRunAt because
  // "completed: Email held for quiet hours" says two opposite things at once.
  const held = log("promo", { status: "running", completedAt: null, durationMs: null, nextRunAt: at(3600) });
  assert.equal(isHeldStep(held), true);
  assert.deepEqual(stepOutcome(held, "waiting"), { tone: "warning", label: "Held" });
  assert.notEqual(stepOutcome(held, "waiting").tone, "success");
  assert.notEqual(stepOutcome(held, "waiting").tone, "danger");
});

test("mid-flight, abandoned and held are three different words", () => {
  // All three are `status: "running"` on the row. The row alone cannot tell them
  // apart; the RUN's status is what does.
  const running = log("promo", { status: "running", completedAt: null, durationMs: null });
  assert.equal(isHeldStep(running), false, "the row written just before a step is attempted has no nextRunAt");
  assert.deepEqual(stepOutcome(running, "running"), { tone: "info", label: "Running" });
  assert.deepEqual(stepOutcome(running, "waiting"), { tone: "info", label: "Running" });
  assert.deepEqual(stepOutcome(running, "failed"), { tone: "neutral", label: "Never finished" });
  assert.deepEqual(stepOutcome(running, "cancelled"), { tone: "neutral", label: "Never finished" });
});

test("finished statuses read the same whatever the run is doing", () => {
  for (const runStatus of ["running", "waiting", "completed", "failed", "cancelled"]) {
    assert.equal(stepOutcome(log("a"), runStatus).label, "Done");
    assert.equal(stepOutcome(log("a", { status: "skipped" }), runStatus).label, "Skipped");
    assert.equal(stepOutcome(log("a", { status: "failed" }), runStatus).label, "Failed");
  }
});

/* ── collapsing a long repeat ────────────────────────────────────────────── */

function bigRepeat(iterations: number, decorate: (i: number) => Partial<TraceStep> = () => ({})) {
  const rows: TraceStep[] = [container("blast", "repeat")];
  for (let i = 0; i < iterations; i++) {
    rows.push(log(`blast/repeat/${i}/sequence/0`, decorate(i)));
  }
  return buildTraceTree(rows)[0];
}

test("a hundred-iteration repeat does not open a hundred iterations", () => {
  const node = bigRepeat(100);
  const open = iterationsToExpand(node);
  assert.ok(open.size <= 6, `opened ${open.size} iterations — that is the wall of scroll again`);
  assert.ok(open.has(0), "the first pass is the shape of the loop");
  assert.ok(open.has(99), "the last pass is where it ended");
});

test("the iteration that went wrong is open, however deep in the loop it is", () => {
  const node = bigRepeat(100, (i) => (i === 57 ? { status: "failed" } : {}));
  const open = iterationsToExpand(node);
  assert.ok(open.has(57), "the one iteration worth reading was left collapsed");

  const heldNode = bigRepeat(100, (i) =>
    i === 42 ? { status: "running", completedAt: null, durationMs: null, nextRunAt: at(60) } : {});
  assert.ok(iterationsToExpand(heldNode).has(42), "a held pass is a problem too");
});

test("an all-failing loop is still bounded", () => {
  const node = bigRepeat(100, () => ({ status: "failed" }));
  const open = iterationsToExpand(node);
  assert.ok(open.size <= 6, `opened ${open.size} — a budget on the problems is the point`);
});

test("a short repeat opens whole — there is nothing to save", () => {
  assert.deepEqual([...iterationsToExpand(bigRepeat(3))].sort((a, b) => a - b), [0, 1, 2]);
});

test("the summary counts iterations and names the bad ones", () => {
  const node = bigRepeat(5, (i) =>
    i === 1 ? { status: "failed" }
    : i === 3 ? { status: "running", completedAt: null, durationMs: null, nextRunAt: at(60) }
    : {});
  const summary = summariseRepeat(node);
  assert.equal(summary.iterations, 5);
  assert.equal(summary.executions, 5);
  assert.deepEqual(summary.failed, [1]);
  assert.deepEqual(summary.held, [3]);
});

test("the summary reaches steps nested below the iteration", () => {
  const node = buildTraceTree([
    container("blast", "repeat"),
    container("blast/repeat/0/sequence/0", "choose"),
    log("blast/repeat/0/sequence/0/choose/0/sequence/0", { status: "failed" }),
  ])[0];
  const summary = summariseRepeat(node);
  assert.equal(summary.executions, 2, "the nested choose and its child both count");
  assert.deepEqual(summary.failed, [0], "a failure two levels down still marks its iteration");
});

/* ── reading a step's recorded output ────────────────────────────────────── */

test("no clauses recorded and a condition with no clauses are different answers", () => {
  // null is "this step recorded nothing" — a send, or a row written before
  // per-clause results existed. [] is "a condition with no clauses", which
  // always passes. Collapsing them accuses every historic row of having
  // evaluated nothing.
  assert.equal(parseClauses(undefined), null);
  assert.equal(parseClauses({}), null);
  assert.equal(parseClauses({ clauses: "nope" }), null);
  assert.deepEqual(parseClauses({ clauses: [] }), []);
});

test("a clause keeps the value it actually SAW", () => {
  const clauses = parseClauses({
    passed: false,
    clauses: [
      { field: "lead.source", operator: "equals", expected: "web", actual: "phone", passed: false },
      { bogus: true },
    ],
  });
  assert.deepEqual(clauses, [
    { field: "lead.source", operator: "equals", expected: "web", actual: "phone", passed: false, negated: false },
  ]);
});

test("a clause under a `not` is read back as negated, and older rows are not", () => {
  // `negated` says whether the clause was REQUIRED or EXCLUDED. Without it the
  // trace is worse than imprecise under a `not`: the clause that matched is the
  // one that made the group fail, so every row would show green beside a step
  // that did not match.
  //
  // Absent on every row written before `not` existed, and `false` is the right
  // reading for those — they were all plain requirements. Anything that is not
  // literally true reads as not-negated, so a hand-edited row cannot invert a
  // historic verdict.
  const clauses = parseClauses({
    passed: false,
    clauses: [
      { field: "lead.source", operator: "equals", expected: "web", actual: "web", passed: true, negated: true },
      { field: "lead.status", operator: "equals", expected: "open", actual: "open", passed: true },
      { field: "lead.status", operator: "equals", expected: "open", actual: "open", passed: true, negated: "yes" },
    ],
  });
  assert.deepEqual(clauses?.map((clause) => clause.negated), [true, false, false]);
  assert.deepEqual(clauses?.map(clauseHeld), [false, true, true], "a negated clause holds by NOT matching");
});

test("a missing field reads as words, not as the string 'undefined'", () => {
  // The commonest reason a condition surprises someone is a field the context
  // never carried, and "undefined" reads like a bug in the trace itself.
  assert.equal(describeValue(undefined), "not set");
  assert.equal(describeValue(null), "null");
  assert.equal(describeValue(""), "(empty)");
  assert.equal(describeValue([]), "(empty list)");
  assert.equal(describeValue(["a", "b"]), "a, b");
  assert.equal(describeValue(0), "0");
  assert.equal(describeValue(false), "false");
});

test("a retry time and an item count survive the JSON round trip", () => {
  assert.deepEqual(parseTimestamp("2026-01-01T08:00:00.000Z"), T0);
  assert.equal(parseTimestamp("not a date"), null);
  assert.equal(parseTimestamp(undefined), null);
  assert.equal(parseItemCount({ items: 12 }), 12);
  assert.equal(parseItemCount({ items: null }), null);
  assert.equal(parseItemCount({}), null);
});

/* ── the wiring, which behaviour cannot reach ────────────────────────────── */

test("trace reads go through the tenant-filtered client, never raw SQL", () => {
  // $queryRaw / $executeRaw bypass the Prisma tenant extension outright, and a
  // trace carries the lead and contact ids of whoever the run enrolled.
  const trace = shipped("src/lib/journeyTrace.ts");
  assert.doesNotMatch(trace, /\$queryRaw|\$executeRaw/, "raw SQL is unscoped here");
  assert.doesNotMatch(trace, /basePrisma/, "basePrisma opts out of the tenant extension");
  assert.match(trace, /import \{ prisma \} from "\.\/db"/);
});

test("the run trace is gated and reachable", () => {
  const page = shipped("src/app/(app)/journeys/activity/page.tsx");
  assert.match(page, /requireOwner\(\)/, "a trace exposes entity ids and must be gated");
  // searchParams is a promise in this Next; reading it synchronously would be
  // silently undefined and every run would render as "not available".
  assert.match(page, /searchParams: Promise<\{ run\?: string \}>/);
  assert.match(page, /await searchParams/);
  assert.match(shipped("src/app/(app)/journeys/page.tsx"), /journeys\/activity\?run=\$\{run\.id\}/);
});
