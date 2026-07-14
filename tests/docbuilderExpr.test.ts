import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCondition, validateExpression } from "../src/lib/docbuilder/expr";

const scope = {
  quotation: { discount: 12, total: 25000, lines: [{ id: 1 }, { id: 2 }] },
  customer: { type: "Enterprise", name: "Acme" },
};

test("empty expression always shows", () => {
  assert.equal(evaluateCondition("", scope), true);
  assert.equal(evaluateCondition("   ", scope), true);
});

test("numeric comparisons", () => {
  assert.equal(evaluateCondition("quotation.discount > 0", scope), true);
  assert.equal(evaluateCondition("quotation.discount > 20", scope), false);
  assert.equal(evaluateCondition("quotation.total >= 25000", scope), true);
});

test("string equality", () => {
  assert.equal(evaluateCondition('customer.type == "Enterprise"', scope), true);
  assert.equal(evaluateCondition('customer.type == "SMB"', scope), false);
  assert.equal(evaluateCondition('customer.type != "SMB"', scope), true);
});

test("collection length", () => {
  assert.equal(evaluateCondition("quotation.lines.length > 0", scope), true);
  assert.equal(evaluateCondition("quotation.lines.length > 5", scope), false);
});

test("boolean logic and precedence", () => {
  assert.equal(evaluateCondition('quotation.discount > 0 && customer.type == "Enterprise"', scope), true);
  assert.equal(evaluateCondition('quotation.discount > 50 || quotation.total > 10000', scope), true);
  assert.equal(evaluateCondition('!(quotation.discount > 50)', scope), true);
});

test("missing paths never throw", () => {
  assert.equal(evaluateCondition("nope.here.deep > 3", scope), false);
  assert.equal(evaluateCondition("customer.missing == null", scope), true);
});

test("malformed expressions fail open by default", () => {
  assert.equal(evaluateCondition("quotation.discount >", scope), true);
  assert.equal(evaluateCondition("quotation.discount > 0", scope, false), true);
  assert.equal(evaluateCondition("(", scope, false), false);
});

test("no code execution: JS is rejected, not run", () => {
  assert.notEqual(validateExpression("process.exit(1)"), null); // call form → parse error
  assert.notEqual(validateExpression("1; while(true){}"), null); // ';' is not a valid char
});

test("prototype gadgets resolve to undefined, not functions", () => {
  assert.equal(evaluateCondition("customer.constructor == null", scope), true);
  assert.equal(evaluateCondition("customer.__proto__ == null", scope), true);
});

test("validateExpression surfaces errors for the editor", () => {
  assert.equal(validateExpression("quotation.total > 100"), null);
  assert.equal(validateExpression(""), null);
  assert.notEqual(validateExpression("a &&"), null);
  assert.notEqual(validateExpression('"unterminated'), null);
});
