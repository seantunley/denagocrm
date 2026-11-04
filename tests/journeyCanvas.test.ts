import assert from "node:assert/strict";
import { test } from "node:test";
import { JOURNEY_STEP_TYPES, parseJourneyDefinition } from "../src/lib/journeyTypes";
import { builderDefinition, builderSteps, initialConfig, type BuilderStep } from "../src/lib/journeyBuilderDefinition";
import {
  JOURNEY_PALETTE,
  START_NODE,
  addNewStep,
  connectSteps,
  findSteps,
  insertStep,
  insertionPoint,
  journeyGraph,
  locate,
  moveStep,
  recordHistory,
  redoHistory,
  removeStep,
  undoHistory,
  updateStep,
  type History,
} from "../src/lib/journeyCanvasGraph";

// The Journey canvas (Sean, 2026-11-04) edits the builder's own step list and saves through builderDefinition. The
// promise it has to keep: opening a journey and saving it unchanged gives back the SAME definition, whatever it holds.

const step = (id: string, type: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): BuilderStep => ({ id, type, config, ...extra });
const wait = (id: string) => step(id, "wait", { amount: 1, unit: "days" });
const group = (field: string, value: string) => ({ logic: "and", conditions: [{ field, operator: "equals", value }] });
/** What the database hands back: JSON, so an `undefined` key is simply absent. */
const stored = (value: unknown) => JSON.parse(JSON.stringify(value));
/** Open in the builder, change nothing, save, store. */
const reopenAndSave = (definition: unknown) => stored(builderDefinition(builderSteps(stored(definition))));

const nested = (): BuilderStep[] => [
  step("vars", "variables", { set: { tier: "gold" } }, { name: "Remember the tier" }),
  step("check", "condition", { condition: group("lead.source", "web") }),
  step("pick", "choose", {
    options: [
      { conditions: group("vars.tier", "gold"), sequence: [wait("a1"), step("gate", "condition", { condition: group("lead.status", "open") })] },
      {
        sequence: [
          step("loop", "repeat", {
            mode: "count",
            count: 3,
            sequence: [step("inner", "choose", { options: [{ conditions: group("repeat.index", "2"), sequence: [step("sms", "send_sms", { message: "Hi {{first_name}}" }, { continueOnError: true })] }] })],
          }),
        ],
      },
    ],
    default: [step("muted", "send_email", { subject: "Hello", body: "Hi" }, { enabled: false })],
  }),
  step("own", "condition", { condition: group("lead.source", "fb"), trueStepId: "end", falseStepId: "follow" }),
  { ...wait("follow"), enabled: false },
  step("end", "stop", { reason: "done" }),
];

test("open → save unchanged gives back the identical definition: nested Choose, Repeat, gates, own targets", () => {
  // As it sits in the database after a save: through the server's own parser.
  const saved = stored(parseJourneyDefinition(builderDefinition(nested())));
  assert.deepEqual(reopenAndSave(saved), saved);
  // …and again: no drift on the second pass either.
  assert.deepEqual(reopenAndSave(reopenAndSave(saved)), saved);
  assert.equal(saved.steps[0].name, "Remember the tier", "a step's name survives (the builder used to drop it)");
  assert.equal(saved.steps.find((s: { id: string }) => s.id === "follow").enabled, false, "a muted step stays muted");
});

test("a step type this build doesn't know survives untouched, top level and nested", () => {
  // Not parseable on purpose (the server refuses an unknown type) — the builder must still not touch it.
  const definition = {
    startStepId: "w",
    steps: [
      { id: "w", type: "wait", nextStepId: "later", config: { amount: 1, unit: "days" } },
      { id: "later", type: "send_carrier_pigeon", nextStepId: "c", config: { bird: "Percy", weights: [1, 2] }, colour: "grey" },
      { id: "c", type: "choose", nextStepId: null, config: { options: [{ sequence: [{ id: "nested_future", type: "teleport", config: { to: "Durban" }, extra: true }] }] } },
    ],
  };
  assert.deepEqual(reopenAndSave(definition), stored(definition));
  // The canvas draws both as cards rather than skipping them.
  const ids = journeyGraph(builderSteps(stored(definition))).nodes.map((n) => n.id);
  assert.ok(ids.includes("later") && ids.includes("nested_future"));
});

test("the canvas shows every step once, and drawing it changes nothing", () => {
  const steps = builderSteps(stored(parseJourneyDefinition(builderDefinition(nested()))));
  const before = stored(steps);
  const { nodes, edges } = journeyGraph(steps);
  assert.deepEqual(stored(steps), before);
  const stepIds = nodes.filter((n) => n.kind === "step").map((n) => n.id).sort();
  assert.deepEqual(stepIds, ["a1", "end", "follow", "gate", "inner", "loop", "muted", "own", "pick", "sms", "check", "vars"].sort());
  assert.equal(new Set(nodes.map((n) => `${n.x},${n.y}`)).size, nodes.length, "no two cards on top of each other");

  const wire = (source: string, handle: string) => edges.filter((e) => e.source === source && e.sourceHandle === handle).map((e) => e.target);
  assert.deepEqual(wire(START_NODE, "out"), ["vars"]);
  assert.deepEqual(wire("check", "yes"), ["pick"], "a builder condition carries on…");
  assert.deepEqual(wire("check", "no"), ["__stop:check"], "…or stops");
  assert.deepEqual(wire("gate", "no"), ["__stop:gate"], "a gate inside a branch stops the run");
  assert.deepEqual(wire("own", "yes"), ["end"], "a condition written with its own targets shows them");
  assert.deepEqual(wire("own", "no"), ["follow"]);
  assert.deepEqual(wire("pick", "option:0"), ["a1"]);
  assert.deepEqual(wire("pick", "option:1"), ["loop"]);
  assert.deepEqual(wire("pick", "default"), ["muted"]);
  assert.deepEqual(wire("pick", "out"), ["own"]);
  assert.deepEqual(wire("gate", "yes"), ["own"], "the end of a branch rejoins after the Choose");
  assert.deepEqual(wire("loop", "sequence"), ["inner"]);
  assert.deepEqual(wire("inner", "out"), ["loop"], "the end of a loop goes round again");
});

test("canvas edits save in the builder's format, and the server's parser accepts them", () => {
  let steps = builderSteps(stored(builderDefinition(nested())));

  // Wire the start to "check": it moves to the front.
  steps = connectSteps(steps, START_NODE, "out", "check") as BuilderStep[];
  assert.equal(steps[0].id, "check");

  // Wire Branch 2 of the Choose to the top-level "vars": it moves into that branch, first.
  steps = connectSteps(steps, "pick", "option:1", "vars") as BuilderStep[];
  assert.equal(locate(steps, "vars")!.list?.slot, "option:1");
  assert.equal(locate(steps, "vars")!.index, 0);

  // A new step after the gate, and the first Choose branch's wait removed.
  steps = insertStep(steps, locate(steps, "gate")!.list, 2, wait("added"));
  steps = removeStep(steps, "a1") as BuilderStep[];
  // Edited through the inspector.
  steps = updateStep(steps, "sms", { ...locate(steps, "sms")!.step, config: { message: "Changed" } });

  const saved = builderDefinition(steps);
  const parsed = parseJourneyDefinition(saved);
  assert.deepEqual(parsed.steps.map((s) => s.id), ["check", "pick", "own", "follow", "end", "check_false_stop"]);
  assert.equal(saved.startStepId, "check");
  const pick = saved.steps.find((s) => s.id === "pick")!.config as { options: { sequence: Record<string, unknown>[] }[] };
  assert.deepEqual(pick.options[0].sequence.map((s) => s.id), ["gate", "added"]);
  assert.deepEqual(pick.options[1].sequence.map((s) => s.id), ["vars", "loop"]);
  assert.equal("nextStepId" in pick.options[1].sequence[0], false, "a step moved into a branch loses its next-step link");
  assert.equal((pick.options[1].sequence[0] as { name?: string }).name, "Remember the tier");
  assert.match(JSON.stringify(saved), /"message":"Changed"/);
  // And the result reopens to itself.
  assert.deepEqual(reopenAndSave(stored(parsed)), stored(parsed));
});

test("a move the journey model can't save is refused with a reason", () => {
  const steps = nested();
  assert.equal(moveStep(steps, "pick", { parentId: "loop", slot: "sequence" }, 0), "A step can't go inside itself");
  assert.equal(connectSteps(steps, "pick", "default", "pick"), "A step can't go inside itself");
  assert.equal(removeStep(steps, "muted"), "A branch needs at least one step");
  assert.equal(connectSteps(steps, START_NODE, "out", "muted"), "A branch needs at least one step");
  assert.match(String(connectSteps(steps, "check", "no", "end")), /run in order/);
  // Moving a step onto the wire it already sits on changes nothing at all.
  assert.equal(connectSteps(steps, "vars", "out", "check"), steps);

  // Nesting stops where the list editor stops: a container needs depth + 1 below the limit.
  let deep: BuilderStep[] = [wait("leaf")];
  for (let i = 0; i < 4; i += 1) deep = [step(`r${i}`, "repeat", { mode: "count", count: 2, sequence: deep })];
  const box = step("box", "repeat", { mode: "count", count: 2, sequence: [wait("x")] });
  assert.match(String(moveStep([...deep, box], "box", { parentId: "r0", slot: "sequence" }, 0)), /nest/);
  assert.ok(Array.isArray(moveStep([...deep, box], "box", { parentId: "r1", slot: "sequence" }, 0)));
});

test("the Nodes palette offers every step type exactly once", () => {
  const offered = JOURNEY_PALETTE.flatMap((group) => [...group.types]);
  assert.deepEqual([...offered].sort(), [...JOURNEY_STEP_TYPES].sort());
  assert.equal(new Set(offered).size, offered.length);
});

test("a palette step is seeded like the list view's, lands after the picked step (or at the end), and saves", () => {
  let steps = nested();
  // Nothing picked: the end of the journey.
  steps = addNewStep(steps, "send_sms", "new_end", null) as BuilderStep[];
  assert.equal(steps.at(-1)!.id, "new_end");
  assert.deepEqual(steps.at(-1)!.config, initialConfig("send_sms"));
  // After a step inside a branch — what a click does with "a1" picked, and a drop on "a1" or its out-wire.
  steps = addNewStep(steps, "choose", "new_choose", insertionPoint(steps, "a1", "out")) as BuilderStep[];
  assert.deepEqual(locate(steps, "new_choose")!.list, { parentId: "pick", slot: "option:0" });
  assert.equal(locate(steps, "new_choose")!.index, 1);
  // Dropped on a branch wire: first in that branch.
  steps = addNewStep(steps, "wait", "new_first", insertionPoint(steps, "pick", "default")) as BuilderStep[];
  assert.equal(locate(steps, "new_first")!.index, 0);
  // Dropped on the start: first in the journey.
  steps = addNewStep(steps, "variables", "new_start", insertionPoint(steps, START_NODE, "out")) as BuilderStep[];
  assert.equal(steps[0].id, "new_start");

  const saved = builderDefinition(steps.map((s) => (s.id === "new_end" ? { ...s, config: { message: "Hi" } } : s)));
  assert.doesNotThrow(() => parseJourneyDefinition(saved));

  // Too deep for another container: refused, as the list view's type picker would not offer one there.
  let deep: BuilderStep[] = [wait("leaf")];
  for (let i = 0; i < 4; i += 1) deep = [step(`r${i}`, "repeat", { mode: "count", count: 2, sequence: deep })];
  assert.match(String(addNewStep(deep, "repeat", "x", insertionPoint(deep, "leaf", "out"))), /nest/);
  assert.ok(Array.isArray(addNewStep(deep, "wait", "x", insertionPoint(deep, "leaf", "out"))));
});

test("Find matches a step's label, type, name and its own text — nested steps included", () => {
  const steps = nested();
  assert.deepEqual(findSteps(steps, "first_name").map((h) => h.id), ["sms"]);
  assert.deepEqual(findSteps(steps, "remember").map((h) => h.id), ["vars"], "by the step's name");
  assert.deepEqual(findSteps(steps, "repeat").map((h) => h.id), ["loop", "inner"], "by label/type, in running order; inner's own text says repeat.index");
  assert.ok(findSteps(steps, "Stop journey").some((h) => h.id === "end"));
  assert.deepEqual(findSteps(steps, "  "), []);
  // A container is found by its own words, not by everything inside it.
  assert.equal(findSteps(steps, "Hi {{first").some((h) => h.id === "pick"), false);
});

test("undo and redo walk the snapshots back and forth, and a new edit clears redo", () => {
  let history: History<string> = { past: [], future: [] };
  history = recordHistory(history, "a");
  history = recordHistory(history, "b");
  const back = undoHistory(history, "c")!;
  assert.equal(back.value, "b");
  const back2 = undoHistory(back.history, back.value)!;
  assert.equal(back2.value, "a");
  assert.equal(undoHistory(back2.history, back2.value), null);
  const forward = redoHistory(back2.history, back2.value)!;
  assert.equal(forward.value, "b");
  assert.equal(recordHistory(forward.history, "x").future.length, 0);
  let long: History<number> = { past: [], future: [] };
  for (let i = 0; i < 80; i += 1) long = recordHistory(long, i);
  assert.equal(long.past.length, 50);
  assert.equal(long.past[0], 30);
});
