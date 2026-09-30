import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { showcaseQuoteTemplate } from "../src/lib/doceditor/standardTemplates";
import { ACCEPTANCE_GEOMETRY, acceptanceFieldRects, showcaseBlockHtml } from "../src/lib/doceditor/showcaseRender";
import { snapFieldsToAcceptanceCards } from "../src/lib/doceditor/fieldSnap";
import type { AcceptanceBlock, DocumentModel, FloatingBlock, OverlayField } from "../src/lib/doceditor/model";

/**
 * The customer's live Signature and Date controls must land ON the showcase
 * acceptance card's lines — at every sheet scale the signing page fits to, and
 * with the controls' own border and padding.
 *
 * Measured against the real page (dev, 375–1920px, DPR 1 and 2) the code path
 * is exact; production drifted because the STORED coordinates had drifted from
 * the card (fields dragged in the pre-#685 editor). So the fix is to derive the
 * fields' positions from the card at send time, and these tests hold both halves.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOL = 2;
type Rect = { x: number; y: number; width: number; height: number };

function parts(doc: DocumentModel) {
  const page = doc.pages[0];
  const card = page.floatingBlocks.find((f) => f.block.type === "acceptance") as FloatingBlock;
  const field = (kind: string) => page.overlayFields.find((f) => f.kind === kind) as OverlayField;
  return { page, card, sig: field("signature"), date: field("date") };
}
/** The card's Signature/Date LINE rows, read off its own rendered HTML (not the constants). */
function lineRows(card: FloatingBlock): Record<"signature" | "date", Rect> {
  const html = showcaseBlockHtml(card.block as AcceptanceBlock, null);
  const rows = [...html.matchAll(/display:flex;align-items:flex-end;gap:\d+px;height:(\d+)px/g)].map((m) => Number(m[1]));
  const g = ACCEPTANCE_GEOMETRY;
  const x = card.x + g.padX + g.labelW + g.gap;
  const width = card.width - g.padX * 2 - g.labelW - g.gap;
  const sigY = card.y + g.pad + g.headerH + g.headerGap + g.textH + rows[0];
  return { signature: { x, y: sigY, width, height: rows[1] }, date: { x, y: sigY + rows[1], width, height: rows[2] } };
}
const rectOf = (f: OverlayField): Rect => ({ x: f.anchor.x, y: f.anchor.y, width: f.width, height: f.height });
function assertOn(control: Rect, line: Rect, what: string) {
  assert.ok(Math.abs(control.x - line.x) <= TOL, `${what}: left ${control.x.toFixed(1)} vs line ${line.x.toFixed(1)}`);
  assert.ok(control.x + control.width <= line.x + line.width + TOL, `${what}: runs past the line`);
  assert.ok(control.y >= line.y - TOL && control.y + control.height <= line.y + line.height + TOL, `${what}: ${control.y.toFixed(1)}–${(control.y + control.height).toFixed(1)} off the row ${line.y.toFixed(1)}–${(line.y + line.height).toFixed(1)}`);
}
const scaled = (r: Rect, s: number): Rect => ({ x: r.x * s, y: r.y * s, width: r.width * s, height: r.height * s });

test("the template's fields are exactly the card's field rects", () => {
  const { card, sig, date } = parts(showcaseQuoteTemplate());
  assert.deepEqual(rectOf(sig), acceptanceFieldRects(card).signature);
  assert.deepEqual(rectOf(date), acceptanceFieldRects(card).date);
  const lines = lineRows(card);
  assertOn(rectOf(sig), lines.signature, "signature");
  assertOn(rectOf(date), lines.date, "date");
});

test("send-time snapping puts drifted fields back on the lines (and moves with a moved card)", () => {
  // The production shape: fields dragged ~12px right and ~15px down in the old editor.
  const drifted = showcaseQuoteTemplate();
  const d = parts(drifted);
  d.sig.anchor = { ...d.sig.anchor, x: d.sig.anchor.x + 12.4, y: d.sig.anchor.y + 15 };
  d.sig.width += 13;
  d.date.anchor = { ...d.date.anchor, x: d.date.anchor.x + 11, y: d.date.anchor.y + 16 };
  // …and a card nudged in the editor, with fields left behind.
  const moved = showcaseQuoteTemplate();
  const m = parts(moved);
  m.card.x += 20;
  m.card.y -= 30;

  for (const [name, doc] of [["drifted fields", drifted], ["moved card", moved]] as const) {
    const snapped = snapFieldsToAcceptanceCards(doc);
    const s = parts(snapped);
    const lines = lineRows(s.card);
    assertOn(rectOf(s.sig), lines.signature, `${name}: signature`);
    assertOn(rectOf(s.date), lines.date, `${name}: date`);
    assert.deepEqual(snapFieldsToAcceptanceCards(snapped), snapped, "idempotent");
  }

  const exact = showcaseQuoteTemplate();
  assert.equal(snapFieldsToAcceptanceCards(exact), exact, "already on the lines: untouched");

  // A field placed well away from any card is the author's choice: left alone.
  const elsewhere = showcaseQuoteTemplate();
  const e = parts(elsewhere);
  e.sig.anchor = { ...e.sig.anchor, x: 40, y: 200 };
  assert.deepEqual(rectOf(parts(snapFieldsToAcceptanceCards(elsewhere)).sig), { x: 40, y: 200, width: e.sig.width, height: e.sig.height });
});

test("the signing page: controls and lines share one scaled sheet, so they coincide at every width", () => {
  const surface = readFileSync(path.join(root, "src/app/signing/[token]/SignSurface.tsx"), "utf8");
  // The controls are placed at the field's own rect, border-box (their 2px
  // border and padding stay inside it), inside the SAME transform as the sheet.
  assert.match(surface, /left: f\.x, top: f\.y, width: f\.width, height: f\.height, boxSizing: "border-box", margin: 0/);
  assert.match(surface, /width: sheets\.width, height: sheets\.height, transform: `scale\(\$\{scale\}\)`/);
  assert.match(surface, /className="sg-sheet"[\s\S]{0,600}\{placed\.filter/);
  // Measured scales of the real page at 375, 768 and >=1024px wide.
  const { card, sig, date } = parts(snapFieldsToAcceptanceCards(showcaseQuoteTemplate()));
  const lines = lineRows(card);
  for (const s of [0.432, 0.927, 1]) {
    assertOn(scaled(rectOf(sig), s), scaled(lines.signature, s), `signature @${s}`);
    assertOn(scaled(rectOf(date), s), scaled(lines.date, s), `date @${s}`);
  }
});

test("send snaps the fields AFTER the overflow move and BEFORE the rows are written", () => {
  const service = readFileSync(path.join(root, "src/lib/signing/service.ts"), "utf8");
  const snapAt = service.indexOf("const frozenDoc = snapFieldsToAcceptanceCards(await freezeQuoteShowcase(");
  assert.notEqual(snapAt, -1);
  assert.ok(snapAt < service.indexOf("signatureField.createMany"), "fields rows come from the snapped snapshot");
});
