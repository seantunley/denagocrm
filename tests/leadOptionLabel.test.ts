import assert from "node:assert/strict";
import { test } from "node:test";

import { leadOptionLabel, shortLeadRef } from "../src/lib/leadOption";

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
