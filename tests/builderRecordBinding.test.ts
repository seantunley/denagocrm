import test from "node:test";
import assert from "node:assert/strict";
import {
  bindingParams,
  parseBuilderRecord,
  recordMatchesTemplate,
  requiredRecordKind,
} from "../src/lib/docbuilder/recordBinding";

test("operational templates declare the correct record family", () => {
  for (const key of ["quote", "invoice", "agreement", "delivery"]) {
    assert.equal(requiredRecordKind(key), "quote");
    assert.equal(recordMatchesTemplate(key, "quote"), true);
    assert.equal(recordMatchesTemplate(key, "jobcard"), false);
  }
  for (const key of ["jobcard", "service-report"]) {
    assert.equal(requiredRecordKind(key), "jobcard");
    assert.equal(recordMatchesTemplate(key, "jobcard"), true);
    assert.equal(recordMatchesTemplate(key, "quote"), false);
  }
  assert.equal(requiredRecordKind("proposal"), "either");
  assert.equal(recordMatchesTemplate("proposal", "quote"), true);
  assert.equal(recordMatchesTemplate("proposal", "jobcard"), true);
});

test("one prefixed record value maps to exactly one generator argument", () => {
  assert.deepEqual(parseBuilderRecord("quote:q-1"), {
    kind: "quote",
    id: "q-1",
  });
  assert.deepEqual(parseBuilderRecord("jobcard:j-1"), {
    kind: "jobcard",
    id: "j-1",
  });
  assert.equal(parseBuilderRecord("quote:"), null);
  assert.equal(parseBuilderRecord("q-1"), null);
  assert.deepEqual(bindingParams("quote:q-1"), { quoteId: "q-1" });
  assert.deepEqual(bindingParams("jobcard:j-1"), { jobCardId: "j-1" });
  assert.deepEqual(bindingParams(""), {});
});

test("the indemnity binds a lead and the warranty claim a warranty claim — and nothing else does", () => {
  assert.equal(requiredRecordKind("indemnity"), "lead");
  assert.equal(requiredRecordKind("warranty-claim"), "warranty");
  for (const kind of ["quote", "jobcard", "warranty"] as const) {
    assert.equal(recordMatchesTemplate("indemnity", kind), false, `indemnity must refuse ${kind}`);
  }
  for (const kind of ["quote", "jobcard", "lead"] as const) {
    assert.equal(recordMatchesTemplate("warranty-claim", kind), false, `warranty-claim must refuse ${kind}`);
  }
  assert.equal(recordMatchesTemplate("indemnity", "lead"), true);
  assert.equal(recordMatchesTemplate("warranty-claim", "warranty"), true);
  for (const key of ["quote", "invoice", "agreement", "delivery", "jobcard", "service-report"]) {
    assert.equal(recordMatchesTemplate(key, "lead"), false, `${key} must refuse a lead`);
    assert.equal(recordMatchesTemplate(key, "warranty"), false, `${key} must refuse a warranty claim`);
  }
  // Inherited Object keys are not template keys.
  assert.equal(requiredRecordKind("constructor"), null);

  assert.deepEqual(parseBuilderRecord("lead:l-1"), { kind: "lead", id: "l-1" });
  assert.deepEqual(parseBuilderRecord("warranty:w-1"), { kind: "warranty", id: "w-1" });
  assert.equal(parseBuilderRecord("contact:c-1"), null);
  assert.deepEqual(bindingParams("lead:l-1"), { leadId: "l-1" });
  assert.deepEqual(bindingParams("warranty:w-1"), { warrantyClaimId: "w-1" });
});
