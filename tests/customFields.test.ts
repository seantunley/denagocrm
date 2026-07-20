import test from "node:test";
import assert from "node:assert/strict";
import {
  slugifyKey,
  isCustomEntity,
  isFieldType,
  displayValue,
  type FieldDef,
} from "../src/lib/customFields-helpers";

const def = (over: Partial<FieldDef> = {}): FieldDef => ({
  id: "d1",
  entity: "contact",
  key: "k",
  label: "L",
  type: "text",
  options: [],
  required: false,
  order: 0,
  active: true,
  ...over,
});

test("slugifyKey lowercases and collapses spaces/punctuation to underscores", () => {
  assert.equal(slugifyKey("VAT Number"), "vat_number");
  assert.equal(slugifyKey("ID number!"), "id_number");
  assert.equal(slugifyKey("Customer's PO #"), "customer_s_po");
  assert.equal(slugifyKey("  trimmed  "), "trimmed");
  assert.equal(slugifyKey("Multi   spaces"), "multi_spaces");
});

test("slugifyKey falls back to 'field' when nothing usable remains", () => {
  assert.equal(slugifyKey("!!!"), "field");
  assert.equal(slugifyKey(""), "field");
});

test("isCustomEntity accepts the known entities and rejects others", () => {
  for (const e of ["contact", "lead", "quote", "case"]) {
    assert.equal(isCustomEntity(e), true, `${e} should be a custom entity`);
  }
  assert.equal(isCustomEntity("vehicle"), false);
  assert.equal(isCustomEntity(""), false);
});

test("isFieldType accepts the known field types and rejects others", () => {
  for (const t of ["text", "textarea", "number", "date", "select", "checkbox", "url"]) {
    assert.equal(isFieldType(t), true, `${t} should be a field type`);
  }
  assert.equal(isFieldType("color"), false);
  assert.equal(isFieldType(""), false);
});

test("displayValue renders checkbox values as Yes / No", () => {
  const cb = def({ type: "checkbox" });
  assert.equal(displayValue(cb, "true"), "Yes");
  assert.equal(displayValue(cb, "false"), "No");
  // Anything that isn't "true" reads as No.
  assert.equal(displayValue(cb, "anything"), "No");
});

test("displayValue shows an em dash for empty values", () => {
  assert.equal(displayValue(def(), null), "—");
  assert.equal(displayValue(def(), ""), "—");
});

test("displayValue passes non-empty, non-checkbox values through unchanged", () => {
  assert.equal(displayValue(def({ type: "text" }), "hello"), "hello");
  assert.equal(displayValue(def({ type: "number" }), "42"), "42");
  assert.equal(displayValue(def({ type: "url" }), "https://x.io"), "https://x.io");
});
