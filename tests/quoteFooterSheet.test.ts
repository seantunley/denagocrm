import test from "node:test";
import assert from "node:assert/strict";

import { blankDocument, newBlock, standardQuoteTemplate } from "../src/lib/doceditor/factory";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";
import { attachQuoteFooterToFinalScreenSheet } from "../src/lib/quoteFooterSheet";

const ctx = { values: {}, rows: [] } as unknown as Parameters<typeof renderDocumentHtml>[1];

/** Return the index of the closing </div> matching the opening div at `openAt`. */
function matchingDivClose(html: string, openAt: number): number {
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = openAt;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    if (m[0].startsWith("</")) {
      depth--;
      if (depth === 0) return m.index;
    } else {
      depth++;
    }
  }
  return -1;
}

test("quote screen footer is a child of the final white sheet, not a sibling below it", () => {
  const doc = blankDocument("Quote footer containment");
  doc.footer = [newBlock("footer")];

  const original = renderDocumentHtml(doc, ctx);
  const html = attachQuoteFooterToFinalScreenSheet(original);

  const pageStart = html.lastIndexOf('<div class="doc-page"');
  const pageClose = matchingDivClose(html, pageStart);
  const screenFooter = html.indexOf('<div class="doc-footer-screen">');
  const printFooter = html.indexOf('<div class="doc-footer doc-footer-print">');

  assert.notEqual(pageStart, -1, "fixture must render a page");
  assert.notEqual(pageClose, -1, "page markup must be balanced");
  assert.notEqual(screenFooter, -1, "screen clone must be emitted");
  assert.notEqual(printFooter, -1, "the original print footer must be retained");

  assert.ok(
    screenFooter > pageStart && screenFooter < pageClose,
    "the visible screen footer must be INSIDE the final .doc-page so the white sheet owns its background",
  );
  assert.ok(
    printFooter > pageClose,
    "the fixed print footer remains outside the page flow so Chromium can repeat it on printed sheets",
  );
});

test("screen and print each show exactly one footer representation", () => {
  const doc = blankDocument("Quote footer media split");
  doc.footer = [newBlock("footer")];
  const html = attachQuoteFooterToFinalScreenSheet(renderDocumentHtml(doc, ctx));

  assert.ok(html.includes(".doc-footer-print { display: none !important; }"));
  assert.ok(html.includes(".doc-footer-screen { display: flow-root; width: 100%; }"));
  assert.ok(html.includes("@media print"));
  assert.ok(html.includes(".doc-footer-screen { display: none !important; }"));

  // The shared renderer's print contract is intentionally untouched: its original
  // footer class still receives fixed positioning and therefore repeats on print.
  assert.match(html, /\.doc-footer \{ position: fixed; bottom:/);
});

test("ordinary in-page quote footer blocks are left byte-for-byte unchanged", () => {
  const html = renderDocumentHtml(standardQuoteTemplate(), ctx);
  assert.ok(!html.includes('<div class="doc-footer">'), "standard quote uses a normal footer block inside its page");
  assert.equal(attachQuoteFooterToFinalScreenSheet(html), html);
});

test("footer attachment is idempotent", () => {
  const doc = blankDocument("Quote footer idempotency");
  doc.footer = [newBlock("footer")];
  const once = attachQuoteFooterToFinalScreenSheet(renderDocumentHtml(doc, ctx));
  assert.equal(attachQuoteFooterToFinalScreenSheet(once), once);
});
