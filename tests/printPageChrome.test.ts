import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { blankDocument } from "../src/lib/doceditor/factory";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";
import { printToolbarHtml } from "../src/lib/printToolbar";
import { PAGE_SIZES } from "../src/lib/doceditor/model";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const ctx = { values: {}, rows: [] } as unknown as Parameters<typeof renderDocumentHtml>[1];

// The CSS carries a comment that mentions "@media screen", so a plain indexOf
// lands in prose rather than on the rule. Slice from the brace.
const screenRule = (html: string) => html.slice(html.indexOf("@media screen {"));

/**
 * The browser print page — the screen a person lands on when they ask for a PDF
 * of a quote. Both facts below shipped broken, and neither announced itself: the
 * page rendered, the button was there, nothing errored.
 */

/*
 * `@page` sizes the PRINTED sheet and does nothing in the browser window. With
 * `body { margin: 0 }` and no width anywhere, the document rendered edge-to-edge
 * across the viewport — text flush left, totals stretched to the far right. It
 * looked nothing like the sheet that comes out of the printer.
 */
test("the page is drawn at its real width on screen, not stretched to the viewport", () => {
  const doc = blankDocument("Quote");
  const rule = screenRule(renderDocumentHtml(doc, ctx));

  assert.equal(doc.style.pageSize, "A4");
  assert.ok(rule.includes(`width: ${PAGE_SIZES.A4.w}px`), "A4 pages must be constrained to the A4 width on screen");
  assert.ok(rule.includes(`padding: ${doc.style.margin}px`), "the page margin must show as padding, or content sits against the paper edge");
  assert.match(renderDocumentHtml(doc, ctx), /<div class="doc-page"/, "the screen rule needs the class it selects on");
});

/*
 * The screen rule must not reach the printed output. Print and the PDF pipeline
 * take their geometry from @page; a stray width or padding here would double the
 * margin on paper.
 */
test("the screen sizing cannot reach print", () => {
  const doc = blankDocument("Quote");
  const html = renderDocumentHtml(doc, ctx);

  const rule = screenRule(html);
  assert.ok(rule.startsWith("@media screen {"), "screen sizing must be inside @media screen");
  assert.ok(html.includes(`@page { size: A4; margin: ${doc.style.margin}px; }`), "the @page rule is what print uses and must be untouched");

  // Everything the screen rule sets must live inside its braces. Walk to the
  // matching close and check the sizing is not also loose in the stylesheet.
  const close = rule.indexOf("\n    }");
  assert.notEqual(close, -1, "the @media screen block is not closed where expected");
  const outside = html.replace(rule.slice(0, close), "");
  assert.ok(!outside.includes(`width: ${PAGE_SIZES.A4.w}px`), "page width must not be set outside @media screen");
});

test("Letter documents get the Letter width, not a hardcoded A4 one", () => {
  const doc = blankDocument("Quote");
  doc.style.pageSize = "Letter";
  const rule = screenRule(renderDocumentHtml(doc, ctx));
  assert.ok(rule.includes(`width: ${PAGE_SIZES.Letter.w}px`));
  assert.ok(!rule.includes(`width: ${PAGE_SIZES.A4.w}px`));
});

/*
 * THE PRINT BUTTON. It was `onclick="window.print()"`, and the app's CSP sets
 * script-src to 'self' plus a nonce with no 'unsafe-inline' — so the browser
 * refused the handler and the button was simply dead. Nothing said so.
 */
test("the print button is wired by a nonced script, never an inline handler", () => {
  const html = printToolbarHtml("/quotes?edit=1", "Back to quote", "abc123");
  assert.doesNotMatch(html, /onclick=/i, "CSP has no 'unsafe-inline'; an inline handler is a dead button");
  assert.ok(html.includes('<script nonce="abc123">'), "the script must carry the request nonce or CSP blocks it too");
  assert.ok(html.includes("window.print()"));
  assert.ok(html.includes('id="doc-print"'), "the script must have the element it binds to");
});

test("a nonce that could break out of the attribute is escaped", () => {
  const html = printToolbarHtml("/q", "Back", '"><script>alert(1)</script>');
  assert.ok(!html.includes('nonce=""'), "an unescaped quote would end the attribute early");
  assert.ok(html.includes("&quot;"), "the quote must be escaped");
  assert.ok(!html.includes("<script>alert(1)"), "the angle brackets must be escaped, not passed through");
});

/*
 * With no nonce the button cannot be made to work, so it is not rendered. A
 * missing control is honest; one that is present and does nothing is not.
 */
test("without a nonce the button is omitted rather than shipped dead", () => {
  const html = printToolbarHtml("/quotes?edit=1", "Back to quote", null);
  assert.ok(!html.includes("Print / Save PDF"));
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("Back to quote"), "the back link still works without script");
});

test("the print route passes the request nonce through to the toolbar", () => {
  const route = read("src/app/(print)/quotes/[id]/print/route.ts");
  assert.ok(
    route.includes('printToolbarHtml(`/quotes?edit=${id}`, "Back to quote", request.headers.get("x-nonce"))'),
    "a toolbar built without the nonce renders no button at all",
  );
});

/*
 * The guard, not just the fix. Any inline handler on a server-rendered surface
 * is dead on arrival under this CSP, and dies silently.
 */
test("no server-rendered HTML string ships an inline event handler", () => {
  const offenders: string[] = [];
  for (const rel of ["src/lib/printToolbar.ts", "src/lib/quotePrintDocument.ts", "src/lib/doceditor/serialize.ts", "src/lib/signing/render.ts"]) {
    const src = read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    if (/ on[a-z]+=["']/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "these render HTML sent to a browser under a nonce-only CSP");
});
