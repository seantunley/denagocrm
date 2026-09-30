import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { renderDocumentHtml, renderSigningSheets, type RenderCtx } from "../src/lib/doceditor/serialize";
import { showcaseQuoteTemplate } from "../src/lib/doceditor/standardTemplates";
import { showcaseBlockHtml } from "../src/lib/doceditor/showcaseRender";
import type { AcceptanceBlock, DocumentModel, FloatingBlock, OverlayField } from "../src/lib/doceditor/model";

/**
 * The customer's signature and date are OVERLAY fields at page coordinates; the
 * lines they belong on are drawn by the floating acceptance card. Each surface
 * that shows both — the printed/PDF page, the customer's signing sheets and the
 * editor canvas — must put the box on the line. The editor did not: at its
 * default 90% zoom it scaled the card's POSITION but not its content, so the
 * boxes sat below and to the left of the lines and ran past the card.
 */

type Rect = { x: number; y: number; w: number; h: number };
const TOL = 2;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const ctx: RenderCtx = {
  tokens: { "customer.name": "Jane Buyer", "company.name": "Denago Cape Town" },
  items: [{ cells: [{ value: "Denago EV Rover XL" }, { value: "1" }, { value: "R 1,00" }, { value: "R 1,00" }] }],
  vars: {},
  bound: true,
};

/** The Signature and Date line rects INSIDE the card, read off the card's own rendered HTML. */
function cardLines(block: AcceptanceBlock, cardWidth: number): { signature: Rect; date: Rect } {
  const html = showcaseBlockHtml(block, ctx);
  const num = (re: RegExp) => Number(re.exec(html)?.[1]);
  const [pad, padX] = [num(/padding:(\d+)px \d+px/), num(/padding:\d+px (\d+)px/)];
  const headerH = num(/display:flex;align-items:center;gap:8px;height:(\d+)px/);
  const textH = num(/height:(\d+)px;margin-top:\d+px/);
  const headerGap = num(/height:\d+px;margin-top:(\d+)px/);
  // The three label + underline rows, in order: name, signature, date.
  const [nameH, sigH, dateH] = [...html.matchAll(/display:flex;align-items:flex-end;gap:\d+px;height:(\d+)px/g)].map((m) => Number(m[1]));
  const labelW = num(/width:(\d+)px;flex:none/);
  const gap = num(/display:flex;align-items:flex-end;gap:(\d+)px/);
  const x = padX + labelW + gap;
  const w = cardWidth - padX * 2 - labelW - gap;
  const sigY = pad + headerH + headerGap + textH + nameH;
  return { signature: { x, y: sigY, w, h: sigH }, date: { x, y: sigY + sigH, w, h: dateH } };
}

function assertOn(field: Rect, line: Rect, what: string) {
  assert.ok(Math.abs(field.x - line.x) <= TOL, `${what}: left edge ${field.x} vs line ${line.x}`);
  assert.ok(field.x + field.w <= line.x + line.w + TOL, `${what}: right edge ${field.x + field.w} past the line ${line.x + line.w}`);
  assert.ok(field.y >= line.y - TOL && field.y + field.h <= line.y + line.h + TOL, `${what}: ${field.y}–${field.y + field.h} not within the row ${line.y}–${line.y + line.h}`);
}

function parts(doc: DocumentModel): { card: FloatingBlock; fields: Record<"signature" | "date", OverlayField> } {
  const page = doc.pages[0];
  const card = page.floatingBlocks.find((f) => f.block.type === "acceptance")!;
  const find = (kind: "signature" | "date") => page.overlayFields.find((f) => f.kind === kind)!;
  return { card, fields: { signature: find("signature"), date: find("date") } };
}

const doc = showcaseQuoteTemplate();
const { card, fields } = parts(doc);
const lines = cardLines(card.block as AcceptanceBlock, card.width);
const pageRect = (line: Rect, dx: number, dy: number, z = 1): Rect => ({ x: (dx + line.x) * z, y: (dy + line.y) * z, w: line.w * z, h: line.h * z });
const fieldRect = (f: OverlayField, dx = 0, dy = 0, z = 1): Rect => ({ x: (f.anchor.x + dx) * z, y: (f.anchor.y + dy) * z, w: f.width * z, h: f.height * z });

test("print / PDF: the dashed boxes sit on the Signature and Date lines", () => {
  const html = renderDocumentHtml(doc, ctx);
  const m = doc.style.margin;
  // Both the card and the fields are written at (x − margin, y − margin) — read them back.
  const cardAt = new RegExp(`position:absolute;left:${card.x - m}px;top:${card.y - m}px;width:${card.width}px`);
  assert.match(html, cardAt, "the card is placed at its page coordinates");
  for (const kind of ["signature", "date"] as const) {
    const f = fields[kind];
    const re = new RegExp(`position:absolute;left:${f.anchor.x - m}px;top:${f.anchor.y - m}px;width:${f.width}px;height:${f.height}px`);
    assert.match(html, re, `${kind} field placed`);
    assertOn(fieldRect(f, -m, -m), pageRect(lines[kind], card.x - m, card.y - m), `print ${kind}`);
  }
});

test("signing sheets: the card at raw sheet coordinates, the controls at the fields' own", () => {
  const sheets = renderSigningSheets(doc, ctx);
  assert.match(sheets.pages[0], new RegExp(`position:absolute;left:${card.x}px;top:${card.y}px;width:${card.width}px`));
  // SignSurface places each control at the field's x/y/width/height inside the
  // same scaled sheet, so a scale applies to both alike.
  const surface = readFileSync(path.join(root, "src/app/signing/[token]/SignSurface.tsx"), "utf8");
  assert.match(surface, /left: f\.x, top: f\.y, width: f\.width, height: f\.height/);
  assert.match(surface, /width: sheets\.width, height: sheets\.height, transform: `scale\(\$\{scale\}\)`/);
  for (const scale of [0.9, 1]) {
    for (const kind of ["signature", "date"] as const) {
      assertOn(fieldRect(fields[kind], 0, 0, scale), pageRect(lines[kind], card.x, card.y, scale), `signing ${kind} @${scale}`);
    }
  }
});

test("editor canvas: content zooms with its position, so the boxes stay on the lines at any zoom", () => {
  const floating = readFileSync(path.join(root, "src/components/doceditor/FloatingLayer.tsx"), "utf8");
  const overlay = readFileSync(path.join(root, "src/components/doceditor/OverlayLayer.tsx"), "utf8");
  const canvas = readFileSync(path.join(root, "src/components/doceditor/Canvas.tsx"), "utf8");
  // The floating block is POSITIONED at px × zoom and its CONTENT is zoomed by
  // the same factor; the overlay field is positioned and sized at px × zoom.
  assert.match(floating, /left: fb\.x \* zoom, top: fb\.y \* zoom, width: fb\.width \* zoom/);
  assert.match(floating, /<div style=\{\{ zoom \}\}>\s*<BlockView/);
  assert.match(overlay, /left: f\.anchor\.x \* zoom, top: f\.anchor\.y \* zoom, width: f\.width \* zoom, height: f\.height \* zoom/);
  assert.match(canvas, /style=\{\{ zoom, fontFamily/, "the flowed content zooms too");
  for (const zoom of [0.75, 0.9, 1, 1.25]) {
    for (const kind of ["signature", "date"] as const) {
      assertOn(fieldRect(fields[kind], 0, 0, zoom), pageRect(lines[kind], card.x, card.y, zoom), `canvas ${kind} @${zoom}`);
    }
  }
  // What it was: position zoomed, content not — the line moves by (1 − zoom) × offset.
  const unzoomed = { ...lines.signature, x: card.x * 0.9 + lines.signature.x, y: card.y * 0.9 + lines.signature.y };
  assert.ok(Math.abs(fieldRect(fields.signature, 0, 0, 0.9).y - unzoomed.y) > TOL, "the old canvas geometry really was off");
});
