import test from "node:test";
import assert from "node:assert/strict";
import {
  slugifyKey,
  isCustomEntity,
  isFieldType,
  displayValue,
  parseFieldValue,
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

// ─── parseFieldValue: the pure validate-before-write logic ──────────────

const ok = (r: ReturnType<typeof parseFieldValue>): string | null => {
  assert.equal(r.ok, true, `expected ok, got error: ${r.ok ? "" : r.error}`);
  return r.ok ? r.value : null;
};
const err = (r: ReturnType<typeof parseFieldValue>): string => {
  assert.equal(r.ok, false, "expected an error");
  return r.ok ? "" : r.error;
};

test("parseFieldValue: required empty non-checkbox is an error, optional empty clears", () => {
  err(parseFieldValue(def({ type: "text", required: true }), "   "));
  assert.equal(ok(parseFieldValue(def({ type: "text", required: false }), "")), null);
  assert.equal(ok(parseFieldValue(def({ type: "text" }), "  hi  ")), "hi");
});

test("parseFieldValue: number must be finite", () => {
  assert.equal(ok(parseFieldValue(def({ type: "number" }), " 42 ")), "42");
  assert.equal(ok(parseFieldValue(def({ type: "number" }), "-3.14")), "-3.14");
  err(parseFieldValue(def({ type: "number" }), "abc"));
  err(parseFieldValue(def({ type: "number" }), "1e999")); // Infinity is not finite
  err(parseFieldValue(def({ type: "number" }), "NaN"));
});

test("parseFieldValue: date must be parseable", () => {
  assert.equal(ok(parseFieldValue(def({ type: "date" }), "2026-07-20")), "2026-07-20");
  err(parseFieldValue(def({ type: "date" }), "not-a-date"));
  err(parseFieldValue(def({ type: "date" }), "2026-13-40"));
});

test("parseFieldValue: url must be http/https only", () => {
  assert.equal(ok(parseFieldValue(def({ type: "url" }), "https://x.io/a")), "https://x.io/a");
  assert.equal(ok(parseFieldValue(def({ type: "url" }), "http://x.io")), "http://x.io");
  err(parseFieldValue(def({ type: "url" }), "javascript:alert(1)"));
  err(parseFieldValue(def({ type: "url" }), "ftp://x.io/file"));
  err(parseFieldValue(def({ type: "url" }), "just text"));
});

test("parseFieldValue: select value must be one of the options", () => {
  const d = def({ type: "select", options: ["A", "B", "C"] });
  assert.equal(ok(parseFieldValue(d, "B")), "B");
  err(parseFieldValue(d, "Z"));
  err(parseFieldValue(d, "a")); // case-sensitive membership
});

test("parseFieldValue: checkbox always yields true/false, never empty or required-blocked", () => {
  const d = def({ type: "checkbox", required: true });
  assert.equal(ok(parseFieldValue(d, "on")), "true");
  assert.equal(ok(parseFieldValue(d, "true")), "true");
  assert.equal(ok(parseFieldValue(d, "false")), "false");
  assert.equal(ok(parseFieldValue(d, "")), "false");
});
