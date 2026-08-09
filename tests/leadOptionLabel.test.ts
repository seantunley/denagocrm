import assert from "node:assert/strict";
import { test } from "node:test";

import { leadOptionLabel, leadOptionLabels, shortLeadRef } from "../src/lib/leadOption";

/**
 * THE BUG THIS COVERS.
 *
 * The quote editor's "Link to a lead" dropdown built its options from
 * `lead.title || lead.name`. `title` is the MODEL the customer wants, and a
 * dealership sells the same few models over and over — so every option in the
 * list read "Denago EV Rover XL" and there was no way to tell the leads apart.
 *
 * Picking the wrong one attaches a quote to another customer's record, so this
 * is not only an annoyance.
 */

test("the customer comes first — it is what distinguishes one lead from another", () => {
  const label = leadOptionLabel({ id: "clx0000000abc123", name: "Mike LD", title: "Denago EV Rover XL" });
  assert.ok(label.startsWith("Mike LD"), `expected the customer first, got ${label}`);
  assert.match(label, /Denago EV Rover XL/, "the interest is still useful, just not first");
});

test("two leads for the same customer and model are still distinguishable", () => {
  // A second quote for a second unit. No combination of human fields separates
  // these, which is why the reference exists.
  const a = leadOptionLabel({ id: "clx000000aaaaaa", name: "Mike LD", title: "Denago EV Rover XL" });
  const b = leadOptionLabel({ id: "clx000000bbbbbb", name: "Mike LD", title: "Denago EV Rover XL" });
  assert.notEqual(a, b, "identical labels are the whole bug");
});

test("the old rule would have produced identical labels — the regression guard", () => {
  const leads = [
    { id: "clx000000aaaaaa", name: "Mike LD", title: "Denago EV Rover XL" },
    { id: "clx000000bbbbbb", name: "Sarah T", title: "Denago EV Rover XL" },
    { id: "clx000000cccccc", name: "Piet K", title: "Denago EV Rover XL" },
  ];
  const oldWay = leads.map((l) => l.title || l.name);
  assert.equal(new Set(oldWay).size, 1, "the old rule collapsed these to one label");

  const now = leads.map(leadOptionLabel);
  assert.equal(new Set(now).size, 3, "every lead must be individually selectable");
});

test("a lead missing its title still reads well", () => {
  const label = leadOptionLabel({ id: "clx000000abc123", name: "Mike LD", title: null });
  assert.match(label, /^Mike LD/);
  assert.doesNotMatch(label, /—\s*·/, "no empty separator where the title would be");
});

test("a lead missing its customer name falls back to what it has", () => {
  const label = leadOptionLabel({ id: "clx000000abc123", name: "", title: "Denago EV Rover XL" });
  assert.match(label, /^Denago EV Rover XL/);
});

test("a lead with nothing but an id is still selectable, never blank", () => {
  // A blank option cannot even be clicked to find out what it is.
  const label = leadOptionLabel({ id: "clx000000abc123", name: null, title: null });
  assert.ok(label.trim().length > 0);
  assert.equal(label, "ABC123");
});

test("whitespace-only fields count as missing", () => {
  const label = leadOptionLabel({ id: "clx000000abc123", name: "   ", title: "  " });
  assert.equal(label, "ABC123");
});

test("the reference is short, stable and upper case", () => {
  assert.equal(shortLeadRef("clx000000abc123"), "ABC123");
  assert.equal(shortLeadRef("clx000000abc123"), shortLeadRef("clx000000abc123"), "stable");
  assert.equal(shortLeadRef("abc"), "ABC", "an id shorter than six characters is used whole");
  assert.equal(shortLeadRef(""), "");
});

test("the label never ends with a dangling separator", () => {
  for (const lead of [
    { id: "clx000000abc123", name: "Mike LD", title: "Rover" },
    { id: "clx000000abc123", name: "Mike LD", title: null },
    { id: "clx000000abc123", name: null, title: "Rover" },
    { id: "", name: "Mike LD", title: "Rover" },
  ]) {
    const label = leadOptionLabel(lead);
    assert.doesNotMatch(label, /[—·]\s*$/, `dangling separator in: ${label}`);
    assert.doesNotMatch(label, /\s{2,}/, `doubled spaces in: ${label}`);
  }
});

// ── uniqueness is a property of the LIST ────────────────────────────────────

/**
 * Review caught this: the first version used the last six characters of the cuid
 * as "the" reference and called that a tie-breaker. It is not one. Two ids ending
 * in the same six characters produce the same label again — and since the whole
 * reason the reference exists is that picking the wrong lead attaches a quote to
 * another customer, "probably unique" is the wrong standard.
 *
 * Uniqueness belongs to the list, so the list is what gets labelled.
 */

test("ids colliding on their last six characters still get distinct labels", () => {
  // The exact failure the short suffix could not prevent.
  const leads = [
    { id: "clx000000aaAAA111ABC123", name: "Mike LD", title: "Rover XL" },
    { id: "clx000000bbBBB222ABC123", name: "Mike LD", title: "Rover XL" },
  ];
  assert.equal(shortLeadRef(leads[0].id), shortLeadRef(leads[1].id), "…they do collide at six");

  const labels = leadOptionLabels(leads).map((l) => l.label);
  assert.equal(new Set(labels).size, 2, `still ambiguous: ${JSON.stringify(labels)}`);
});

test("the reference grows only as far as it has to", () => {
  // Nobody should read a longer handle than the situation requires.
  const distinct = leadOptionLabels([
    { id: "clx000000aaaaaa", name: "Mike LD", title: "Rover XL" },
    { id: "clx000000bbbbbb", name: "Mike LD", title: "Rover XL" },
  ]);
  for (const option of distinct) {
    const ref = option.label.split("·").pop()!.trim();
    assert.equal(ref.length, 6, `expected a six-character ref, got ${ref}`);
  }
});

test("a reference is only shown when something is actually ambiguous", () => {
  // A handle on every option is noise when no two options are alike.
  const labels = leadOptionLabels([
    { id: "clx000000aaaaaa", name: "Mike LD", title: "Rover XL" },
    { id: "clx000000bbbbbb", name: "Sarah T", title: "Rover XL" },
  ]).map((l) => l.label);
  assert.deepEqual(labels, ["Mike LD — Rover XL", "Sarah T — Rover XL"]);
});

test("every option in a realistic list is distinct", () => {
  const leads = Array.from({ length: 40 }, (_, i) => ({
    id: `clx${String(i).padStart(3, "0")}shared`,
    name: "Mike LD",
    title: "Denago EV Rover XL",
  }));
  const labels = leadOptionLabels(leads).map((l) => l.label);
  assert.equal(new Set(labels).size, leads.length, "no two options may read the same");
});

test("identical ids are not papered over", () => {
  // Two entries sharing an id is a data problem no reference length can fix, and
  // inventing a difference would hide it.
  const labels = leadOptionLabels([
    { id: "clx000000aaaaaa", name: "Mike LD", title: "Rover" },
    { id: "clx000000aaaaaa", name: "Mike LD", title: "Rover" },
  ]).map((l) => l.label);
  assert.equal(labels[0], labels[1], "the labels match because the leads genuinely do");
});

test("an empty list is fine", () => {
  assert.deepEqual(leadOptionLabels([]), []);
});

test("the original fields survive labelling", () => {
  // The pages read contactId off the result.
  const [option] = leadOptionLabels([
    { id: "clx000000aaaaaa", name: "Mike LD", title: "Rover", contactId: "c1" },
  ]);
  assert.equal((option as { contactId?: string }).contactId, "c1");
});
