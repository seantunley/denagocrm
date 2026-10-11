import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { pdfPaperFor } from "../src/lib/pdfPaper";
import { blankDocument, newBlock } from "../src/lib/doceditor/factory";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";
import { STANDARD_TEMPLATE_KEYS, standardTemplateFor } from "../src/lib/doceditor/standardTemplates";

/** A document set to Letter is printed on Letter paper — it used to come out on A4. */

test("the paper is the one the document's own page rule asks for", () => {
  const letter = blankDocument("Letter");
  letter.style = { ...letter.style, pageSize: "Letter" };
  assert.equal(pdfPaperFor(renderDocumentHtml(letter, null)), "Letter");
  assert.equal(pdfPaperFor(renderDocumentHtml(blankDocument("A4"), null)), "A4");
});

test("every standard layout still prints on A4", () => {
  for (const key of STANDARD_TEMPLATE_KEYS) assert.equal(pdfPaperFor(renderDocumentHtml(standardTemplateFor(key), null)), "A4", key);
});

test("words typed into a document cannot change its paper", () => {
  const doc = blankDocument("Typed");
  const text = newBlock("text");
  if (text.type === "text") text.value = [{ type: "p", children: [{ text: "@page { size: letter; margin: 0 }" }] }];
  doc.pages[0].rows[0].columns[0].blocks = [text];
  const html = renderDocumentHtml(doc, null);
  assert.ok(html.includes("@page { size: letter; margin: 0 }"), "the words are in the body");
  assert.equal(pdfPaperFor(html), "A4");
});

test("anything that is not one of our documents is A4, as it always was", () => {
  assert.equal(pdfPaperFor("<html><body>plain</body></html>"), "A4");
  assert.equal(pdfPaperFor("<style>@page { size: A4; margin: 12mm }</style><p>x</p>"), "A4");
  assert.equal(pdfPaperFor("<style>@page{size:Letter}</style>"), "Letter");
  assert.equal(pdfPaperFor(""), "A4");
});

test("the one place PDFs are made asks it", () => {
  assert.match(readFileSync("src/lib/customDocs.ts", "utf8"), /format: pdfPaperFor\(html\),/);
});
