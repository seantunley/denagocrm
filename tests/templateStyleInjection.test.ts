import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cssColor, isSafeCssColor } from "../src/lib/doceditor/css";
import { parseDocument } from "../src/lib/doceditor/model";
import { standardQuoteTemplate } from "../src/lib/doceditor/factory";
import { renderSigningSheets, renderEmailHtml } from "../src/lib/doceditor/serialize";

/**
 * The serializer builds inline styles by concatenation:
 *
 *     `<th style="background:${block.headerBg};color:${block.headerColor}">`
 *
 * Text content went through esc(); these never did, and every one of them was a
 * plain z.string() a template author types. Reproduced against the real
 * production "Sales agreement" template: accent, color, bg, headerBg,
 * headerColor and ink ALL closed the style attribute and added an event handler.
 * fontFamily and align did not, because they are z.enum.
 *
 * That is stored XSS on the PUBLIC signing page — the sheets go to
 * dangerouslySetInnerHTML in SignSurface, so it runs in the customer's browser,
 * on our origin, on the page where they are about to sign and where their
 * signing token is in the URL. The author needs only docbuilder.manage; the
 * victim needs no account at all.
 */

const CTX = { tokens: {} as Record<string, string>, items: [], vars: {} };

const BREAKOUT = `#fff" onmouseover="alert(1)" x="`;

test("a colour that closes its own attribute is refused", () => {
  assert.equal(cssColor(BREAKOUT, "#ea580c"), "#ea580c");
  assert.equal(isSafeCssColor(BREAKOUT), false);
  for (const payload of [
    `red" onload="x`,
    `#fff'; background:url(javascript:alert(1)); '`,
    `expression(alert(1))`,
    `url(https://evil.example/x.png)`,
    `#fff;position:fixed;top:0;left:0;width:100vw;height:100vh`,
    `</style><script>alert(1)</script>`,
    `#fff" data-x="`,
  ]) {
    assert.equal(isSafeCssColor(payload), false, `${payload} must not be accepted`);
    assert.equal(cssColor(payload, "#000"), "#000");
  }
});

test("real colours still work — the fix must not break every template", () => {
  for (const good of [
    "#fff",
    "#ffffff",
    "#ffffffcc",
    "#EA580C",
    "rgb(12, 34, 56)",
    "rgba(12, 34, 56, 0.5)",
    "hsl(210, 50%, 40%)",
    "red",
    "transparent",
    "currentColor",
  ]) {
    assert.equal(isSafeCssColor(good), true, `${good} is a legitimate colour`);
    assert.equal(cssColor(good, "#000"), good, `${good} must pass through unchanged`);
  }
});

test("the schema normalises a poisoned colour instead of rejecting the document", () => {
  // Rejecting would make one odd colour stop a whole template rendering, and
  // every template already stored has to keep working.
  const doc = standardQuoteTemplate();
  const poisoned = JSON.parse(JSON.stringify(doc)) as { style: { accent: string; ink: string } };
  poisoned.style.accent = BREAKOUT;
  poisoned.style.ink = BREAKOUT;

  const parsed = parseDocument(poisoned);
  assert.ok(parsed, "the document must still parse");
  assert.equal(parsed.style.accent, "#ea580c", "the payload is replaced by the default");
  assert.equal(parsed.style.ink, "#020617");
});

test("no rendered output carries the payload, on any surface", () => {
  // Both layers together: schema normalisation AND render-time sanitising. The
  // second matters because the serializer is also handed documents that did not
  // come through parseDocument.
  const doc = standardQuoteTemplate();
  const poisoned = JSON.parse(JSON.stringify(doc));
  const paint = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(paint);
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (/^(accent|color|bg|headerBg|headerColor|ink)$/.test(k) && typeof v === "string") {
          (node as Record<string, unknown>)[k] = BREAKOUT;
        } else paint(v);
      }
    }
  };
  paint(poisoned);

  // (a) through the schema, as a saved template would be
  const parsed = parseDocument(poisoned);
  assert.ok(parsed);
  // (b) and straight to the serializer, bypassing the schema entirely
  for (const model of [parsed, poisoned]) {
    const sheets = renderSigningSheets(model, CTX);
    const html = `${sheets.pages.join("\n")}\n${sheets.css ?? ""}\n${renderEmailHtml(model, CTX)}`;
    assert.doesNotMatch(html, /onmouseover/, "no event handler may reach the signing page");
    assert.doesNotMatch(html, /alert\(1\)/, "no part of the payload may survive");
    assert.doesNotMatch(html, /style="[^"]*"[^>]*"/, "no style attribute may be closed early");
  }
});

test("the stylesheet is sanitised too, not just the style attributes", () => {
  // renderSigningSheets also emits a <style> block, which SignSurface injects
  // with dangerouslySetInnerHTML. That sink is WORSE than an attribute: inside
  // <style>, `</style><script>…` needs no attribute breakout at all. The first
  // pass of this fix wrapped the attribute interpolations and missed these ten;
  // the structural test below is what found them.
  const doc = standardQuoteTemplate();
  doc.style.ink = "</style><script>alert(1)</script>";
  doc.style.accent = "</style><script>alert(1)</script>";
  const { css } = renderSigningSheets(doc, CTX);
  assert.doesNotMatch(css, /<\/style>/i, "a colour must not be able to close the stylesheet");
  assert.doesNotMatch(css, /<script/i);
});

test("every colour interpolation in the serializer goes through cssColor", () => {
  // A new block type with a colour field is the obvious way for this to come
  // back, so fail on a raw one rather than trusting review to catch it.
  const code = readSerializer();
  const raw = [...code.matchAll(/\$\{(?!cssColor)[^}]*\b(accent|headerBg|headerColor|ink|bg)\b[^}]*\}/g)];
  assert.deepEqual(
    raw.map((m) => m[0]),
    [],
    "these colour values are spliced into a style attribute unsanitised",
  );
});

function readSerializer(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return readFileSync(path.join(root, "src/lib/doceditor/serialize.ts"), "utf8");
}
