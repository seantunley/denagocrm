import test from "node:test";
import assert from "node:assert/strict";
import {
  isFieldValueComplete,
  missingRequiredForRecipient,
  type FillableField,
} from "../src/lib/signing/fieldValidation";

test("isFieldValueComplete is kind-aware for checkboxes", () => {
  assert.equal(isFieldValueComplete("checkbox", "true"), true);
  assert.equal(isFieldValueComplete("checkbox", "false"), false); // unchecked submits "false"
  assert.equal(isFieldValueComplete("checkbox", ""), false);
  assert.equal(isFieldValueComplete("text", "hello"), true);
  assert.equal(isFieldValueComplete("text", "   "), false);
  assert.equal(isFieldValueComplete("text", undefined), false);
});

// A required SHARED field (fillable by any recipient). Recipient 1 signs and
// completes it; recipient 2 must still complete it themselves — the first
// signer's value must not let the second skip their own acknowledgement.
const sharedCheckbox: FillableField = { id: "f1", kind: "checkbox", required: true };

test("second signer cannot skip a required shared checkbox the first already checked", () => {
  // Recipient 1: checks it — satisfied.
  assert.equal(
    missingRequiredForRecipient([sharedCheckbox], new Map([["f1", "true"]]), new Set()),
    false,
  );
  // Recipient 2: omits it entirely (no submission for f1), no prior response of
  // their own — still MISSING even though the field is globally filled.
  assert.equal(
    missingRequiredForRecipient([sharedCheckbox], new Map(), new Set()),
    true,
  );
  // Recipient 2: submits it UNCHECKED ("false") — still MISSING (kind-aware).
  assert.equal(
    missingRequiredForRecipient([sharedCheckbox], new Map([["f1", "false"]]), new Set()),
    true,
  );
  // Recipient 2: actually checks it — satisfied.
  assert.equal(
    missingRequiredForRecipient([sharedCheckbox], new Map([["f1", "true"]]), new Set()),
    false,
  );
});

test("a recipient's own prior durable response satisfies the requirement (re-submit)", () => {
  assert.equal(
    missingRequiredForRecipient([sharedCheckbox], new Map(), new Set(["f1"])),
    false,
  );
});

test("optional fields are never missing; required text must be non-empty", () => {
  const optionalText: FillableField = { id: "f2", kind: "text", required: false };
  const requiredText: FillableField = { id: "f3", kind: "text", required: true };
  assert.equal(missingRequiredForRecipient([optionalText], new Map(), new Set()), false);
  assert.equal(missingRequiredForRecipient([requiredText], new Map([["f3", ""]]), new Set()), true);
  assert.equal(missingRequiredForRecipient([requiredText], new Map([["f3", "Jane"]]), new Set()), false);
});
