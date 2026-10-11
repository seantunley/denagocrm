import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { showcaseQuoteTemplate } from "../src/lib/doceditor/standardTemplates";
import { updateFloating } from "../src/lib/doceditor/ops";
import { acceptanceFieldRects } from "../src/lib/doceditor/showcaseRender";
import { carryAcceptanceFields, fieldsOnAcceptanceCard, SNAP_REACH } from "../src/lib/doceditor/fieldSnap";
import type { DocumentModel, OverlayField } from "../src/lib/doceditor/model";

/** An acceptance card takes the signature and date fields on its lines with it. */

const rect = (f: OverlayField) => ({ x: f.anchor.x, y: f.anchor.y, width: f.width, height: f.height });
function parts(doc: DocumentModel) {
  const page = doc.pages.find((p) => p.floatingBlocks.some((fb) => fb.block.type === "acceptance"))!;
  const card = page.floatingBlocks.find((fb) => fb.block.type === "acceptance")!;
  const on = fieldsOnAcceptanceCard(page.overlayFields, card);
  return { page, card, sig: on.signature!, date: on.date! };
}

test("the standard quote's signature and date are found on its acceptance card", () => {
  const { card, sig, date } = parts(showcaseQuoteTemplate());
  const slots = acceptanceFieldRects(card);
  assert.deepEqual(rect(sig), slots.signature);
  assert.deepEqual(rect(date), slots.date);
});

test("dragging the card moves both fields by exactly the same amount", () => {
  const doc = showcaseQuoteTemplate();
  const before = parts(doc);
  const moved = updateFloating(doc, before.card.block.id, { x: before.card.x + 37, y: before.card.y - 112 });
  const after = parts(moved);
  assert.equal(after.sig.id, before.sig.id);
  assert.deepEqual([after.sig.anchor.x - before.sig.anchor.x, after.sig.anchor.y - before.sig.anchor.y], [37, -112]);
  assert.deepEqual([after.date.anchor.x - before.date.anchor.x, after.date.anchor.y - before.date.anchor.y], [37, -112]);
  // …and they are exactly on the moved card's lines.
  assert.deepEqual(rect(after.sig), acceptanceFieldRects(after.card).signature);
  assert.deepEqual(rect(after.date), acceptanceFieldRects(after.card).date);
  // Nothing else on the page moved.
  const others = (d: DocumentModel) => parts(d).page.overlayFields.filter((f) => f.id !== before.sig.id && f.id !== before.date.id).map(rect);
  assert.deepEqual(others(moved), others(doc));
  // The input document is untouched (ops never mutate).
  assert.deepEqual(rect(parts(doc).sig), rect(before.sig));
});

test("resizing the card keeps the signature on its line at the new width", () => {
  const doc = showcaseQuoteTemplate();
  const { card } = parts(doc);
  const after = parts(updateFloating(doc, card.block.id, { width: card.width - 60 }));
  assert.deepEqual(rect(after.sig), acceptanceFieldRects(after.card).signature);
  assert.equal(after.sig.width, acceptanceFieldRects(card).signature.width - 60);
});

test("a field that drifted a little is put back on the line by the move; one placed elsewhere is left alone", () => {
  const doc = showcaseQuoteTemplate();
  const { page, card, sig } = parts(doc);
  const drifted = page.overlayFields.map((f) => (f.id === sig.id ? { ...f, anchor: { ...f.anchor, x: f.anchor.x + 9, y: f.anchor.y - 7 } } : f));
  const carried = carryAcceptanceFields(drifted, card, { ...card, x: card.x + 10 });
  assert.deepEqual(rect(carried.find((f) => f.id === sig.id)!), acceptanceFieldRects({ ...card, x: card.x + 10 }).signature);

  const far = page.overlayFields.map((f) => (f.id === sig.id ? { ...f, anchor: { ...f.anchor, x: f.anchor.x + SNAP_REACH + 1 } } : f));
  const untouched = carryAcceptanceFields(far, card, { ...card, x: card.x + 10 }).find((f) => f.id === sig.id)!;
  assert.equal(untouched.anchor.x, sig.anchor.x + SNAP_REACH + 1, "a field its author placed off the line is not the card's to move");
});

test("moving any other freely placed block moves no field", () => {
  const doc = showcaseQuoteTemplate();
  const { page } = parts(doc);
  const other = page.floatingBlocks.find((fb) => fb.block.type !== "acceptance");
  if (!other) return;
  const moved = updateFloating(doc, other.block.id, { x: other.x + 50, y: other.y + 50 });
  const samePage = moved.pages.find((p) => p.id === page.id)!;
  assert.deepEqual(samePage.overlayFields.map(rect), page.overlayFields.map(rect));
});

test("the editor no longer tells you to move the fields yourself, and both layers have alignment guides", () => {
  const props = readFileSync("src/components/doceditor/ShowcaseProps.tsx", "utf8");
  assert.doesNotMatch(props, /move those two fields with it/);
  assert.match(props, /They move with the card/);
  for (const layer of ["FloatingLayer.tsx", "OverlayLayer.tsx"]) {
    assert.match(readFileSync(`src/components/doceditor/${layer}`, "utf8"), /\{\.\.\.alignmentGuides\(targetEl\)\}/, layer);
  }
  assert.match(readFileSync("src/components/doceditor/FloatingLayer.tsx", "utf8"), /data-float-id=\{fb\.id\}/);
  const guides = readFileSync("src/components/doceditor/alignmentGuides.ts", "utf8");
  assert.match(guides, /querySelectorAll<HTMLElement>\("\[data-field-id\], \[data-float-id\]"\)\)\.filter\(\(el\) => el !== target\)/);
});
