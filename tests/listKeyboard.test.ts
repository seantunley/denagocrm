import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { listKeyAction, rowDestination, SHORTCUTS, stepIndex, type KeyInput } from "../src/lib/listKeys";

const src = (rel: string) => readFileSync(rel, "utf8");
const press = (key: string, over: Partial<KeyInput> = {}) =>
  listKeyAction({ key, metaKey: false, ctrlKey: false, altKey: false, typing: false, overlayOpen: false, onRow: false, ...over });

test("j / k move, ? helps and 1–5 jump to a stage — from anywhere that isn't a field", () => {
  assert.deepEqual(press("j"), { kind: "move", by: 1 });
  assert.deepEqual(press("k"), { kind: "move", by: -1 });
  assert.deepEqual(press("?"), { kind: "help" });
  assert.deepEqual(press("3"), { kind: "stage", index: 2 });
  assert.equal(press("6"), null, "five stages, not more");
  assert.equal(press("ArrowDown", { onRow: true }), null, "arrows still scroll, and move a card being dragged");
});

test("Enter, e, w and a act only on the row you're on — never on a button or link that has focus", () => {
  assert.equal(press("Enter"), null);
  assert.equal(press("e"), null);
  assert.deepEqual(press("Enter", { onRow: true }), { kind: "open" });
  assert.deepEqual(press("e", { onRow: true }), { kind: "email" });
  assert.deepEqual(press("w", { onRow: true }), { kind: "whatsapp" });
  assert.deepEqual(press("a", { onRow: true }), { kind: "activity" });
});

test("typing, an open dialog or a modifier keeps the key what it was", () => {
  for (const over of [{ typing: true }, { overlayOpen: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
    assert.equal(press("j", { onRow: true, ...over }), null, JSON.stringify(over));
    assert.equal(press("e", { onRow: true, ...over }), null, JSON.stringify(over));
  }
});

test("j from nowhere starts at the top, k at the bottom; neither runs off the end", () => {
  assert.equal(stepIndex(-1, 4, 1), 0);
  assert.equal(stepIndex(-1, 4, -1), 3);
  assert.equal(stepIndex(3, 4, 1), 3);
  assert.equal(stepIndex(0, 4, -1), 0);
  assert.equal(stepIndex(1, 4, 1), 2);
  assert.equal(stepIndex(-1, 0, 1), -1);
});

test("e / w / a open the deal ready for that; a row with no deal does nothing", () => {
  const row = { href: "/leads/L1", lead: "L1" };
  assert.equal(rowDestination({ kind: "open" }, row), "/leads/L1");
  assert.equal(rowDestination({ kind: "email" }, row), "/leads/L1?compose=email");
  assert.equal(rowDestination({ kind: "whatsapp" }, row), "/leads/L1?compose=whatsapp");
  assert.equal(rowDestination({ kind: "activity" }, row), "/leads/L1?tab=activities&schedule=1");
  assert.equal(rowDestination({ kind: "email" }, { href: "/contacts/C1" }), null);
});

test("the cheat sheet lists every key", () => {
  const listed = SHORTCUTS.flatMap((s) => s.keys).join(" ");
  for (const key of ["⌘K", "N", "J", "K", "Enter", "E", "W", "A", "1", "5", "?"]) assert.ok(listed.includes(key), key);
});

test("the board, the leads list, contacts and quotes opt in; the deal ones name their lead", () => {
  const board = src("src/components/KanbanBoard.tsx");
  assert.match(board, /data-nav-row=""\s+data-nav-href=\{`\/leads\/\$\{lead\.id\}`\}\s+data-nav-lead=\{lead\.id\}/);
  assert.match(board, /data-nav-stage=""/);
  assert.match(board, /useSensor\(KeyboardSensor, \{ keyboardCodes: \{ start: \["Space"\], cancel: \["Escape"\], end: \["Space", "Enter"\] \} \}\)/, "Enter opens a card; Space drags it");
  assert.match(src("src/app/(app)/leads/list/page.tsx"), /data-nav-row="" data-nav-href=\{`\/leads\/\$\{lead\.id\}`\} data-nav-lead=\{lead\.id\}/);
  assert.match(src("src/app/(app)/contacts/page.tsx"), /data-nav-row="" data-nav-href=\{`\/contacts\/\$\{contact\.id\}`\}/);
  assert.match(src("src/app/(app)/quotes/page.tsx"), /data-nav-row="" data-nav-href=\{`\/quotes\/\$\{quote\.id\}`\} data-nav-lead=\{quote\.leadId \?\? undefined\}/);
  assert.match(src("src/app/(app)/layout.tsx"), /<ListKeyboard \/>/);
});

test("arriving with ?compose= opens the composer, and nothing is sent without a click", () => {
  assert.match(src("src/components/EmailComposer.tsx"), /const askedEmail = useSearchParams\(\)\.get\("compose"\) === "email";\s+useEffect\(\(\) => \{\s+if \(askedEmail\) void openRef\.current\(\);/);
  assert.match(src("src/components/CustomerComposer.tsx"), /useState<Mode \| undefined>\(askedWhatsApp \? "whatsapp" : offered\[0\]\)/);
  assert.match(src("src/components/CustomerComposer.tsx"), /offered\.includes\("whatsapp"\)/, "only where this person may WhatsApp");
});
