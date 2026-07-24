import test from "node:test";
import assert from "node:assert/strict";
import { assertSurveyTransition, SURVEY_STATUSES, validateSurveyQuestions } from "../src/lib/surveyLifecycle";

test("survey lifecycle exposes the governed states", () => {
  assert.deepEqual(SURVEY_STATUSES, ["draft", "in_review", "changes_requested", "approved", "published", "inactive", "archived"]);
});

test("survey lifecycle accepts review and publication path", () => {
  assert.doesNotThrow(() => assertSurveyTransition("draft", "in_review"));
  assert.doesNotThrow(() => assertSurveyTransition("in_review", "approved"));
  assert.doesNotThrow(() => assertSurveyTransition("approved", "published"));
  assert.doesNotThrow(() => assertSurveyTransition("published", "inactive"));
});

test("survey lifecycle refuses direct draft publication", () => {
  assert.throws(() => assertSurveyTransition("draft", "published"), /Invalid survey transition/);
  assert.throws(() => assertSurveyTransition("archived", "draft"), /Invalid survey transition/);
});

test("survey question validation catches missing, duplicate and unsupported questions", () => {
  assert.deepEqual(validateSurveyQuestions([]), ["Add at least one question"]);
  const errors = validateSurveyQuestions([
    { id: "q1", type: "rating", label: "Score" },
    { id: "q1", type: "magic", label: "" },
  ]);
  assert.ok(errors.some((error) => error.includes("unique ID")));
  assert.ok(errors.some((error) => error.includes("needs a label")));
  assert.ok(errors.some((error) => error.includes("Unsupported question type")));
});
