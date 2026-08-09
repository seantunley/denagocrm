import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderSignature } from "../src/lib/dashboard/renderSignature";
import type { CardConfig, DashboardConfig, SectionConfig } from "../src/lib/dashboard/config";

/**
 * Source with CRLF normalised.
 *
 * This repo stores CRLF, so an anchor written with a bare newline silently never
 * matches — which reads as a missing guard rather than a broken test.
 */
const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

/** …and with comments stripped, so a rule cannot be satisfied by prose about it. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Saving called revalidatePath("/") every time, so every autosave re-ran the
 * whole home screen — every card's queries — for a change that was usually one
 * card moving one place. In development that was a 17-to-23 second round trip
 * per save, and a drag fires one on every pause.
 *
 * It also remounted the card tree, so every dnd-kit droppable unregistered and
 * registered again mid-gesture. Under StrictMode's double-invoked effects that
 * passed React's nested-update limit and threw "Maximum update depth exceeded"
 * into the route's error boundary: the error page after heavy dragging.
 *
 * The signature is the question "would the server draw something different?".
 * The editor refreshes only when its answer changes.
 */

/* ── fixtures ─────────────────────────────────────────────────────── */

const card = (id: string, extra: Record<string, unknown> = {}): CardConfig =>
  ({ id, type: "heading", span: 1, text: id, ...extra }) as CardConfig;

const section = (id: string, cards: CardConfig[], extra: Record<string, unknown> = {}) =>
  ({ id, columnSpan: 1, cards, ...extra }) as SectionConfig;

const config = (sections: SectionConfig[]): DashboardConfig => ({
  version: 1,
  views: [{ id: "v1", title: "Overview", path: "overview", columns: 3, sections }],
});

/* ── what must NOT trigger a refresh ──────────────────────────────── */

test("reordering cards within a section changes nothing", () => {
  const before = config([section("s1", [card("a"), card("b"), card("c")])]);
  const after = config([section("s1", [card("c"), card("a"), card("b")])]);
  assert.equal(renderSignature(before), renderSignature(after));
});

test("moving a card between plain sections changes nothing", () => {
  // `fill()` in lib/dashboard/cards.tsx takes the section as `_section` and does
  // not read it, so a card's node genuinely does not depend on where it sits.
  const before = config([section("s1", [card("a"), card("b")]), section("s2", [])]);
  const after = config([section("s1", [card("b")]), section("s2", [card("a")])]);
  assert.equal(renderSignature(before), renderSignature(after));
});

test("span and rows change nothing — the client applies both", () => {
  const before = config([section("s1", [card("a", { span: 1, rows: 1 })])]);
  const after = config([section("s1", [card("a", { span: 4, rows: 3 })])]);
  assert.equal(renderSignature(before), renderSignature(after));
});

test("renaming a section or changing its width changes nothing", () => {
  const before = config([section("s1", [card("a")], { title: "Sales", columnSpan: 1 })]);
  const after = config([section("s1", [card("a")], { title: "Pipeline", columnSpan: 3 })]);
  assert.equal(renderSignature(before), renderSignature(after));
});

test("reordering whole sections changes nothing", () => {
  const before = config([section("s1", [card("a")]), section("s2", [card("b")])]);
  const after = config([section("s2", [card("b")]), section("s1", [card("a")])]);
  assert.equal(renderSignature(before), renderSignature(after));
});

/* ── what MUST trigger a refresh ──────────────────────────────────── */

test("adding a card needs the server — there is no node for it yet", () => {
  const before = config([section("s1", [card("a")])]);
  const after = config([section("s1", [card("a"), card("b")])]);
  assert.notEqual(renderSignature(before), renderSignature(after));
});

test("removing a card changes it", () => {
  const before = config([section("s1", [card("a"), card("b")])]);
  const after = config([section("s1", [card("a")])]);
  assert.notEqual(renderSignature(before), renderSignature(after));
});

test("reconfiguring a card changes it", () => {
  const before = config([section("s1", [card("a", { text: "Revenue" })])]);
  const after = config([section("s1", [card("a", { text: "Margin" })])]);
  assert.notEqual(renderSignature(before), renderSignature(after));
});

test("switching a card off changes it", () => {
  // `fill()` returns early for a disabled card, so its node stops existing.
  const before = config([section("s1", [card("a")])]);
  const after = config([section("s1", [card("a", { disabled: true })])]);
  assert.notEqual(renderSignature(before), renderSignature(after));
});

test("a card's own visibility rule changes it", () => {
  const before = config([section("s1", [card("a")])]);
  const after = config([
    section("s1", [card("a", { visibility: [{ kind: "role", role: "OWNER" }] })]),
  ]);
  assert.notEqual(renderSignature(before), renderSignature(after));
});

test("moving a card into a CONDITIONED section changes it", () => {
  /*
   * The trap. `renderViewSlots` refuses a whole section up front when its rule
   * does not admit the viewer, and then NONE of its cards is drawn — so a card
   * moved into one changes what the server produces even though the card itself
   * did not change. A signature built from card definitions alone would call
   * this a plain move and never refresh, and the card would sit there as a
   * placeholder that never resolves.
   */
  const conditioned = { visibility: [{ kind: "role", role: "OWNER" }] };
  const before = config([section("s1", [card("a")]), section("s2", [], conditioned)]);
  const after = config([section("s1", []), section("s2", [card("a")], conditioned)]);
  assert.notEqual(renderSignature(before), renderSignature(after));
});

test("moving a card OUT of a conditioned section changes it too", () => {
  const conditioned = { visibility: [{ kind: "role", role: "OWNER" }] };
  const before = config([section("s1", []), section("s2", [card("a")], conditioned)]);
  const after = config([section("s1", [card("a")]), section("s2", [], conditioned)]);
  assert.notEqual(renderSignature(before), renderSignature(after));
});

test("changing a section's own rule changes every card in it", () => {
  const before = config([section("s1", [card("a")])]);
  const after = config([
    section("s1", [card("a")], { visibility: [{ kind: "role", role: "OWNER" }] }),
  ]);
  assert.notEqual(renderSignature(before), renderSignature(after));
});

/* ── containers ───────────────────────────────────────────────────── */

const container = (id: string, children: CardConfig[]): CardConfig =>
  ({ id, type: "grid", span: 2, columns: 2, cards: children }) as unknown as CardConfig;

test("reordering cards INSIDE a container changes it", () => {
  // A container is drawn on the server with its children inside it, so their
  // order is part of that node — unlike top-level order, which is the client's.
  const before = config([section("s1", [container("g1", [card("a"), card("b")])])]);
  const after = config([section("s1", [container("g1", [card("b"), card("a")])])]);
  assert.notEqual(renderSignature(before), renderSignature(after));
});

test("reconfiguring a card inside a container changes it", () => {
  const before = config([section("s1", [container("g1", [card("a", { text: "One" })])])]);
  const after = config([section("s1", [container("g1", [card("a", { text: "Two" })])])]);
  assert.notEqual(renderSignature(before), renderSignature(after));
});

test("a nested card's span and rows still change nothing", () => {
  const before = config([section("s1", [container("g1", [card("a", { span: 1 })])])]);
  const after = config([section("s1", [container("g1", [card("a", { span: 2 })])])]);
  assert.equal(renderSignature(before), renderSignature(after));
});

/* ── the wiring ───────────────────────────────────────────────────── */

test("saving a config no longer revalidates the whole home screen", () => {
  const actions = code("src/app/actions/dashboardConfig.ts");
  const fn = actions.slice(actions.indexOf("export async function saveDashboardConfig"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.doesNotMatch(
    body,
    /revalidatePath/,
    "a card moving must not re-run every card's queries on the server",
  );
});

test("the editor asks for a redraw itself, and only when one is needed", () => {
  const provider = code("src/components/dashboard/editor/EditorProvider.tsx");
  assert.match(
    provider,
    /if \(renderSignature\(previous\) !== renderSignature\(next\)\) router\.refresh\(\);/,
    "the refresh must be conditional on the signature, not unconditional",
  );
});
