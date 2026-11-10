import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isFieldShown,
  parseFieldValue,
  parseShowWhen,
  ruleValue,
  displayValue,
  type FieldDef,
} from "../src/lib/customFields-helpers";
import { evaluateStageMove, parseStageCriteria, describeUnmet, type StageGateFacts } from "../src/lib/stageGate";
import { evaluateConditions, parseJourneyDefinition, parseConditionGroup } from "../src/lib/journeyTypes";

const def = (over: Partial<FieldDef> = {}): FieldDef => ({
  id: "d1",
  entity: "lead",
  key: "k",
  label: "L",
  type: "text",
  options: [],
  required: false,
  order: 0,
  active: true,
  showWhen: null,
  linkTo: null,
  ...over,
});

// ── Show only when… ─────────────────────────────────────────────────────────

const payingBy = def({ id: "a", key: "paying_by", label: "Paying by", type: "select", options: ["Cash", "Finance"] });
const financeHouse = def({ id: "b", key: "finance_house", label: "Finance house", required: true, showWhen: { key: "paying_by", op: "equals", value: "Finance" } });
const byKey = new Map([payingBy, financeHouse].map((d) => [d.key, d]));

test("a field shows only when its controlling answer matches", () => {
  assert.equal(isFieldShown(financeHouse, byKey, new Map([["paying_by", "Finance"]])), true);
  assert.equal(isFieldShown(financeHouse, byKey, new Map([["paying_by", "Cash"]])), false);
  assert.equal(isFieldShown(financeHouse, byKey, new Map()), false);
});

test("a rule pointing at a missing field, or a loop, shows the field rather than hiding data", () => {
  const orphan = def({ key: "x", showWhen: { key: "gone", op: "filled" } });
  assert.equal(isFieldShown(orphan, new Map([["x", orphan]]), new Map()), true);
  const a = def({ id: "1", key: "a", showWhen: { key: "b", op: "filled" } });
  const b = def({ id: "2", key: "b", showWhen: { key: "a", op: "filled" } });
  const loop = new Map([["a", a], ["b", b]]);
  assert.doesNotThrow(() => isFieldShown(a, loop, new Map()));
});

test("a hidden controller hides what depends on it", () => {
  const branch = def({ id: "c", key: "branch", showWhen: { key: "finance_house", op: "filled" } });
  const all = new Map([payingBy, financeHouse, branch].map((d) => [d.key, d]));
  assert.equal(isFieldShown(branch, all, new Map([["paying_by", "Cash"], ["finance_house", "WesBank"]])), false);
  assert.equal(isFieldShown(branch, all, new Map([["paying_by", "Finance"], ["finance_house", "WesBank"]])), true);
});

test("checkbox and tick-several controllers", () => {
  const trade = def({ id: "t", key: "trade_in", type: "checkbox" });
  const tradeModel = def({ id: "m", key: "trade_model", showWhen: { key: "trade_in", op: "equals", value: "true" } });
  const m = new Map([["trade_in", trade], ["trade_model", tradeModel]]);
  assert.equal(isFieldShown(tradeModel, m, new Map([["trade_in", "true"]])), true);
  assert.equal(isFieldShown(tradeModel, m, new Map([["trade_in", "false"]])), false);

  const extras = def({ id: "e", key: "extras", type: "multiselect", options: ["Lift kit", "Roof"] });
  const liftHeight = def({ id: "h", key: "lift_height", showWhen: { key: "extras", op: "equals", value: "Lift kit" } });
  const e = new Map([["extras", extras], ["lift_height", liftHeight]]);
  assert.equal(isFieldShown(liftHeight, e, new Map([["extras", '["Roof","Lift kit"]']])), true);
  assert.equal(isFieldShown(liftHeight, e, new Map([["extras", '["Roof"]']])), false);
});

test("parseShowWhen refuses junk", () => {
  assert.equal(parseShowWhen(null), null);
  assert.equal(parseShowWhen({ key: "", op: "equals" }), null);
  assert.equal(parseShowWhen({ key: "a", op: "bogus" }), null);
  assert.deepEqual(parseShowWhen({ key: "a", op: "filled", value: "x" }), { key: "a", op: "filled" });
});

// ── New field types ─────────────────────────────────────────────────────────

test("money accepts SA formats and stores two decimals", () => {
  const money = def({ type: "currency", label: "Deposit" });
  assert.deepEqual(parseFieldValue(money, "R 1 250,50"), { ok: true, value: "1250.50" });
  assert.deepEqual(parseFieldValue(money, "1,250.5"), { ok: true, value: "1250.50" });
  assert.deepEqual(parseFieldValue(money, "300"), { ok: true, value: "300.00" });
  assert.equal(parseFieldValue(money, "lots").ok, false);
});

test("tick-several keeps option order and refuses unknown options", () => {
  const extras = def({ type: "multiselect", label: "Extras", options: ["Lift kit", "Roof", "Lights"] });
  assert.deepEqual(parseFieldValue(extras, '["Lights","Lift kit"]'), { ok: true, value: '["Lift kit","Lights"]' });
  assert.deepEqual(parseFieldValue(extras, "[]"), { ok: true, value: null });
  assert.equal(parseFieldValue(extras, '["Spoiler"]').ok, false);
  assert.equal(parseFieldValue({ ...extras, required: true }, "[]").ok, false);
  assert.equal(displayValue(extras, '["Lift kit","Lights"]'), "Lift kit, Lights");
});

test("a link must look like a record id; a linked record the viewer can't open is not named", () => {
  const link = def({ type: "link", label: "Trade-in vehicle", linkTo: "vehicle" });
  assert.deepEqual(parseFieldValue(link, "cmr9dafws000ckz04xhnl8b7r"), { ok: true, value: "cmr9dafws000ckz04xhnl8b7r" });
  assert.equal(parseFieldValue(link, "'; drop table").ok, false);
  assert.equal(displayValue(link, "abc12345", { vehicle: [{ id: "abc12345", label: "Rover XL · CA 1" }] }), "Rover XL · CA 1");
  assert.equal(displayValue(link, "zzz12345", { vehicle: [] }), "A record you can't open");
});

test("ruleValue types values for the rule engines", () => {
  assert.equal(ruleValue(def({ type: "currency" }), "1250.50"), 1250.5);
  assert.deepEqual(ruleValue(def({ type: "multiselect" }), '["A"]'), ["A"]);
  assert.equal(ruleValue(def({ type: "checkbox" }), null), "false");
  assert.equal(ruleValue(def({ type: "text" }), ""), null);
});

// ── Stage rules on custom fields ────────────────────────────────────────────

const facts = (custom: Record<string, unknown>): StageGateFacts => ({
  lead: { valueCents: 0, assignedToId: null, productId: null, email: null, phone: null, source: "web" },
  quote: { count: 0, sentCount: 0, acceptedCount: 0, latestStatus: null },
  contact: { linked: true, email: null, phone: null },
  activity: { plannedCount: 0, overdueCount: 0, testDriveCount: 0 },
  signature: { completedCount: 0, pendingCount: 0 },
  stage: { ageDays: 0 },
  custom,
});

test("a stage rule can require a custom field, and names it when it blocks", () => {
  const criteria = parseStageCriteria({ logic: "and", conditions: [{ field: "custom.finance_house", operator: "is_not_empty" }] });
  assert.ok(criteria);
  const move = (custom: Record<string, unknown>) =>
    evaluateStageMove({
      from: { stageId: "a", order: 1, exit: { mode: "off", criteria: null } },
      to: { stageId: "b", order: 2, entry: { mode: "block", criteria } },
      samePipeline: true,
      facts: facts(custom),
      canOverride: false,
    });
  assert.equal(move({ finance_house: "WesBank" }).allowed, true);
  const refused = move({ finance_house: null });
  assert.equal(refused.allowed, false);
  assert.equal(describeUnmet(refused.unmet[0]), "Finance house is not empty");
});

test("stage rules refuse a malformed custom key", () => {
  assert.throws(() => parseStageCriteria({ logic: "and", conditions: [{ field: "custom.Bad Key", operator: "is_empty" }] }));
  assert.throws(() => parseStageCriteria({ logic: "and", conditions: [{ field: "custom.__proto__.x", operator: "is_empty" }] }));
  // Keys are slugified, so never start with "_" — which also keeps `__proto__` out.
  assert.throws(() => parseStageCriteria({ logic: "and", conditions: [{ field: "custom.__proto__", operator: "is_empty" }] }));
  assert.throws(() => parseConditionGroup({ logic: "and", conditions: [{ field: "lead.custom.__proto__", operator: "is_empty" }] }));
});

// ── Journeys ────────────────────────────────────────────────────────────────

test("journey conditions read lead and contact custom fields", () => {
  const group = parseConditionGroup({ logic: "and", conditions: [{ field: "lead.custom.extras", operator: "contains", value: "Roof" }, { field: "contact.custom.vip", operator: "equals", value: "true" }] });
  assert.ok(group);
  const context = { lead: { custom: { extras: ["Roof"] } }, contact: { custom: { vip: "true" } } };
  assert.equal(evaluateConditions(group, context), true);
  assert.equal(evaluateConditions(group, { ...context, contact: { custom: { vip: "false" } } }), false);
  assert.throws(() => parseConditionGroup({ logic: "and", conditions: [{ field: "quote.custom.x", operator: "is_empty" }] }));
});

test("a Set a field step validates its shape", () => {
  const step = (config: Record<string, unknown>) => ({ startStepId: "s", steps: [{ id: "s", type: "set_field", config }] });
  assert.doesNotThrow(() => parseJourneyDefinition(step({ entity: "lead", key: "finance_house", value: "WesBank" })));
  assert.doesNotThrow(() => parseJourneyDefinition(step({ entity: "contact", key: "", value: "" })));
  assert.throws(() => parseJourneyDefinition(step({ entity: "quote", key: "x" })));
  assert.throws(() => parseJourneyDefinition(step({ entity: "lead", key: "Not A Key" })));
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test("the step runs through the form's own parser, in the run's workspace", () => {
  const src = readFileSync("src/lib/journeyStepExecutor.ts", "utf8");
  assert.match(src, /case "set_field":[\s\S]*setCustomFieldByKey\(entity, recordId, key, String\(step\.config\.value \?\? ""\), tenantId\)/);
  const lib = readFileSync("src/lib/customFieldValues.ts", "utf8");
  assert.match(lib, /setCustomFieldByKey[\s\S]*parseFieldValue\(def, raw\)/);
});

test("the save action skips fields hidden by Show only when", () => {
  const src = readFileSync("src/app/actions/customFields.ts", "utf8");
  assert.match(src, /if \(!isFieldShown\(def, defsByKey, submitted\)\) continue;/);
});
