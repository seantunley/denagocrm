import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateConditions,
  parseConditionGroup,
  parseJourneyDefinition,
} from "../src/lib/journeyTypes";

test("evaluates nested allow-listed conditions", () => {
  const condition = parseConditionGroup({
    logic: "and",
    conditions: [
      { field: "lead.source", operator: "in", value: "facebook,website" },
      {
        logic: "or",
        conditions: [
          { field: "lead.valueCents", operator: "greater_or_equal", value: 15000000 },
          { field: "contact.tags", operator: "contains", value: "vip" },
        ],
      },
    ],
  });

  assert.equal(evaluateConditions(condition, {
    event: { type: "lead_created" },
    lead: { source: "facebook", valueCents: 16000000 },
    contact: { tags: [] },
  }), true);

  assert.equal(evaluateConditions(condition, {
    event: { type: "lead_created" },
    lead: { source: "manual", valueCents: 16000000 },
    contact: { tags: ["vip"] },
  }), false);
});

test("rejects unsupported fields and operators", () => {
  assert.throws(() => parseConditionGroup({
    logic: "and",
    conditions: [{ field: "user.passwordHash", operator: "equals", value: "x" }],
  }), /Unsupported condition field/);

  assert.throws(() => parseConditionGroup({
    logic: "and",
    conditions: [{ field: "lead.source", operator: "execute", value: "x" }],
  }), /Unsupported condition operator/);
});

test("validates multi-step definitions and branch targets", () => {
  const definition = parseJourneyDefinition({
    startStepId: "email",
    steps: [
      {
        id: "email",
        type: "send_email",
        nextStepId: "wait",
        config: { subject: "Hello", body: "Hi {{first_name}}" },
      },
      {
        id: "wait",
        type: "wait",
        nextStepId: "branch",
        config: { amount: 1, unit: "days" },
      },
      {
        id: "branch",
        type: "condition",
        nextStepId: null,
        config: {
          condition: {
            logic: "and",
            conditions: [{ field: "contact.hasVehicle", operator: "equals", value: true }],
          },
          trueStepId: "stop-yes",
          falseStepId: "stop-no",
        },
      },
      { id: "stop-yes", type: "stop", nextStepId: null, config: {} },
      { id: "stop-no", type: "stop", nextStepId: null, config: {} },
    ],
  });

  assert.equal(definition.steps.length, 5);
  assert.throws(() => parseJourneyDefinition({
    startStepId: "one",
    steps: [{ id: "one", type: "wait", nextStepId: "missing", config: {} }],
  }), /missing next step/);
});

test("rejects arbitrary step types and duplicate IDs", () => {
  assert.throws(() => parseJourneyDefinition({
    startStepId: "one",
    steps: [{ id: "one", type: "run_script", config: {} }],
  }), /Unsupported journey step/);

  assert.throws(() => parseJourneyDefinition({
    startStepId: "one",
    steps: [
      { id: "one", type: "wait", config: {} },
      { id: "one", type: "stop", config: {} },
    ],
  }), /Duplicate step ID/);
});
