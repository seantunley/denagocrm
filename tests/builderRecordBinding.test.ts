import test from "node:test";
import assert from "node:assert/strict";
import {
  bindingParams,
  parseBuilderRecord,
  recordMatchesTemplate,
  requiredRecordKind,
} from "../src/lib/docbuilder/recordBinding";

test("operational templates declare the correct record family", () => {
  for (const key of ["quote", "invoice", "agreement", "delivery", "indemnity"]) {
    assert.equal(requiredRecordKind(key), "quote");
    assert.equal(recordMatchesTemplate(key, "quote"), true);
    assert.equal(recordMatchesTemplate(key, "jobcard"), false);
  }
  for (const key of ["jobcard", "service-report", "warranty-claim"]) {
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
