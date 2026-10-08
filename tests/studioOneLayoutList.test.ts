import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/*
 * Sean, 2026-10-08, of the "Builder layouts" list under Document Studio: "Are
 * these not duplicates?" They were — the same eight layouts as the cards above,
 * with a delete bin beside each layout real documents print from.
 */
test("a document's own layout is listed once — on its card — and the bottom list holds only the extras", () => {
  const section = src("src/app/(app)/document-studio/builder-section.tsx");
  // The card's layout, picked the way the page picks it: default first, else the newest.
  assert.match(section, /const card = ofKey\.find\(\(template\) => template\.isDefault\) \?\? ofKey\[0\];/);
  assert.match(section, /const otherLayouts = templates\.filter\(\(template\) => !cardLayoutIds\.has\(template\.id\)\);/);
  assert.match(section, /\{otherLayouts\.length > 0 && \(/, "no empty box when there are no extras");
  assert.match(section, /\{otherLayouts\.map\(\(template\) => \(/);
  assert.doesNotMatch(section, /Builder layouts\s*<\/p>/, "the duplicate list is gone");
  // Generating still offers every layout, the card ones included.
  assert.match(section, /\{templates\.map\(\(template\) => \(\s*<option key=\{template\.id\} value=\{template\.id\}>/);
});

test("what the list offered that the cards did not — Preview PDF — is on the card", () => {
  const page = src("src/app/(app)/document-studio/page.tsx");
  assert.match(page, /<a href=\{`\/api\/pdf\/doc-editor\/\$\{layout\.id\}`\} target="_blank" rel="noreferrer">/);
  assert.match(page, /Preview PDF/);
});
