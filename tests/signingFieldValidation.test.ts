import assert from "node:assert/strict";
import test from "node:test";
import { isFieldValueComplete } from "../src/lib/signing/fieldValidation";

test("an unchecked checkbox (submitted as the string \"false\") is not complete", () => {
  assert.equal(isFieldValueComplete("checkbox", "false"), false);
});

test("a checked checkbox is complete", () => {
  assert.equal(isFieldValueComplete("checkbox", "true"), true);
});

test("a missing/empty checkbox value is not complete", () => {
  assert.equal(isFieldValueComplete("checkbox", undefined), false);
  assert.equal(isFieldValueComplete("checkbox", null), false);
  assert.equal(isFieldValueComplete("checkbox", ""), false);
});

test("a non-checkbox field is complete when it has a non-empty value", () => {
  assert.equal(isFieldValueComplete("text", "Jane Doe"), true);
  assert.equal(isFieldValueComplete("text", ""), false);
  assert.equal(isFieldValueComplete("text", "   "), false);
  assert.equal(isFieldValueComplete("text", undefined), false);
});
