import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Sean, 2026-10-18: pipeline cards collapsible, collapsed by default, with no empty deal-value / next-step placeholders.
const board = readFileSync("src/components/KanbanBoard.tsx", "utf8");
const card = board.slice(board.indexOf("function LeadCard("), board.indexOf("type LeadActionHandlers"));

test("cards start collapsed; the chevron opens and closes one", () => {
  assert.match(card, /const \[open, setOpen\] = useState\(false\);/);
  assert.match(card, /onClick=\{\(\) => setOpen\(\(value\) => !value\)\}/);
  assert.match(card, /aria-expanded=\{open\}/);
  assert.match(card, /\{open && \(/);
});

test("the chevron never picks the card up: the board drags on mousedown and touchstart (review of #898)", () => {
  assert.match(board, /useSensor\(MouseSensor/);
  assert.match(board, /useSensor\(TouchSensor/);
  const toggle = card.slice(card.indexOf("<button"), card.indexOf("<ChevronDown"));
  for (const handler of ["onPointerDown", "onMouseDown", "onTouchStart", "onKeyDown"]) {
    assert.match(toggle, new RegExp(`${handler}=\\{\\(event\\) => event\\.stopPropagation\\(\\)\\}`), handler);
  }
  // At least a 32px target (size-8), for fingers.
  assert.match(toggle, /\bsize-8\b/);
});

test("no empty placeholders: the deal-value heading only over an amount, the next step only when there is one", () => {
  assert.doesNotMatch(card, /Not estimated|No next step scheduled/);
  assert.match(card, /\{hasAmount && <p[^>]*>Deal value<\/p>\}/);
  assert.match(card, /const hasAmount = lead\.valueCents > 0;/);
  assert.match(card, /\{lead\.nextStep && \(/);
});
