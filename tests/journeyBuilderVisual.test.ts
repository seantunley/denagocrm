import assert from "node:assert/strict";
import { test } from "node:test";
import { JOURNEY_STEP_TYPES, parseJourneyDefinition } from "../src/lib/journeyTypes";
import { builderDefinition, initialConfig, type BuilderStep } from "../src/lib/journeyBuilderDefinition";

// Review 2026-11-02 (Sean's item 4): Choose, Repeat, Wait for an event, Wait until true and Set variables were
// JSON-only in the Journey builder. They are edited visually now — so what the builder SAVES must be what the engine's
// own parser accepts, and nothing an author wrote may be lost on the way.

const step = (id: string, type: string, config: Record<string, unknown> = {}): BuilderStep => ({ id, type, config });
const wait = (id: string) => step(id, "wait", { amount: 1, unit: "days" });
const group = (field: string, value: string, logic = "and") => ({ logic, conditions: [{ field, operator: "equals", value }] });

test("every step type starts with a config the parser accepts (bar the reason a mark-lost step must be given)", () => {
  for (const type of JOURNEY_STEP_TYPES) {
    const config = initialConfig(type);
    if (type === "lead_mark_lost") config.reason = "Went elsewhere";
    // The module steps have nothing to configure but need their own trigger; they still parse as steps.
    assert.doesNotThrow(() => parseJourneyDefinition(builderDefinition([step("s1", type, config)])), `${type} starts unsaveable`);
  }
});

test("a journey with every container and wait saves, and nested steps follow the sequence rules", () => {
  const steps: BuilderStep[] = [
    step("pick", "choose", {
      options: [
        { conditions: group("lead.source", "facebook", "or"), sequence: [wait("a1"), step("gate", "condition", { condition: group("vars.tier", "gold", "not"), trueStepId: "x", falseStepId: "y" })] },
        { sequence: [step("loop", "repeat", { mode: "until", until: { logic: "and", conditions: [group("lead.status", "won")] }, sequence: [wait("a2")] })] },
      ],
      default: [wait("a3")],
    }),
    step("vars", "variables", { set: { tier: "gold", greeting: "Hi {{first_name}}" } }),
    step("hold", "wait_for_trigger", { triggers: ["quote_signed", "lead_lost"], timeoutMinutes: 2 * 1440, continueOnTimeout: false }),
    step("until", "wait_for_condition", { condition: group("lead.status", "won"), timeoutMinutes: 60, continueOnTimeout: true }),
    step("check", "condition", { condition: { logic: "not", conditions: [{ field: "lead.source", operator: "equals", value: "x" }, group("lead.status", "lost")] } }),
    step("end", "stop", { reason: "done" }),
  ];
  const saved = builderDefinition(steps);
  const parsed = parseJourneyDefinition(saved);
  assert.equal(parsed.startStepId, "pick");

  const pick = saved.steps[0] as unknown as { config: { options: { sequence: Record<string, unknown>[] }[] } };
  const gate = pick.config.options[0].sequence[1] as { nextStepId?: unknown; config: Record<string, unknown> };
  assert.equal("nextStepId" in gate, false, "a nested step names no next step — a sequence runs in order");
  assert.deepEqual(gate.config, { condition: group("vars.tier", "gold", "not") }, "a nested condition is a gate: its branch targets go, its group stays");

  // Top level: the builder's condition carries on or stops; nothing else lost.
  const check = saved.steps.find((s) => s.id === "check")!;
  assert.equal(check.config.trueStepId, "end");
  assert.equal(check.config.falseStepId, "check_false_stop");
  assert.equal((check.config.condition as { conditions: unknown[] }).conditions.length, 2, "a `not` group of two is saved whole");
  assert.ok(saved.steps.some((s) => s.id === "check_false_stop" && s.config.systemGenerated === true));
  assert.deepEqual(saved.steps.find((s) => s.id === "vars")!.config, { set: { tier: "gold", greeting: "Hi {{first_name}}" } });
  assert.equal(saved.steps.find((s) => s.id === "hold")!.config.continueOnTimeout, false);
});

test("a top-level condition with its own branch targets keeps them, and gets no extra stop", () => {
  const steps: BuilderStep[] = [
    step("check", "condition", { condition: group("lead.source", "web"), trueStepId: "b", falseStepId: "a" }),
    wait("a"),
    wait("b"),
  ];
  const saved = builderDefinition(steps);
  assert.equal(saved.steps.find((s) => s.id === "check")!.config.trueStepId, "b");
  assert.equal(saved.steps.find((s) => s.id === "check")!.config.falseStepId, "a");
  assert.equal(saved.steps.some((s) => s.id === "check_false_stop"), false);
  assert.doesNotThrow(() => parseJourneyDefinition(saved));
});

test("re-opening a saved journey and saving again changes nothing", () => {
  const first = builderDefinition([
    step("c", "condition", { condition: group("lead.source", "web") }),
    step("r", "repeat", { mode: "count", count: 3, sequence: [wait("w")] }),
  ]);
  // What the builder loads: the saved steps minus the stops it generated.
  const reopened = first.steps.filter((s) => s.config.systemGenerated !== true).map(({ id, type, config }) => ({ id, type, config }));
  assert.deepEqual(builderDefinition(reopened), first);
});
