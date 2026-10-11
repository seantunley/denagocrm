import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { imageFrame, imageFrameCss } from "../src/lib/doceditor/imageFrame";
import { blankDocument, newBlock, newColumn, newRow } from "../src/lib/doceditor/factory";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";
import { documentSchema, type DocumentBlock, type ImageBlock } from "../src/lib/doceditor/model";

/** An image block can hold a shape; one that holds none prints exactly as it always did. */

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const image = (over: Partial<ImageBlock>): ImageBlock => ({ ...(newBlock("image") as ImageBlock), src: PIXEL, ...over });
const render = (block: ImageBlock) => {
  const doc = blankDocument("Img");
  doc.pages[0].rows = [newRow([newColumn(100, [block as DocumentBlock])])];
  return renderDocumentHtml(doc, {} as never);
};

test("an image with no shape set is styled byte-for-byte as before", () => {
  assert.equal(imageFrameCss(imageFrame(image({}))), "width:100%;height:auto;");
  assert.equal(imageFrameCss(imageFrame(image({ widthPct: 40, rounded: true }))), "width:40%;height:auto;border-radius:8px;");
  assert.equal(imageFrameCss(imageFrame(image({ widthPct: 500 }))), "width:100%;height:auto;", "width is still clamped");
  assert.equal(imageFrameCss(imageFrame(image({ aspect: "original", fit: "contain", focalX: 10 }))), "width:100%;height:auto;", "'as the picture is' ignores fit and focal point");
  assert.match(render(image({ widthPct: 40, rounded: true })), /<img src="data:image\/png[^"]*" alt="" style="width:40%;height:auto;border-radius:8px;"\/><\/div>/);
});

test("a shape fills (cropped round the focal point) or fits", () => {
  assert.equal(imageFrameCss(imageFrame(image({ aspect: "16:9" }))), "width:100%;height:auto;aspect-ratio:16 / 9;object-fit:cover;object-position:50% 50%;");
  assert.equal(imageFrameCss(imageFrame(image({ aspect: "1:1", focalX: 20, focalY: 80, rounded: true }))), "width:100%;height:auto;aspect-ratio:1 / 1;object-fit:cover;object-position:20% 80%;border-radius:8px;");
  assert.equal(imageFrameCss(imageFrame(image({ aspect: "3:4", fit: "contain", focalX: 20 }))), "width:100%;height:auto;aspect-ratio:3 / 4;object-fit:contain;", "fitting inside crops nothing, so there is no focal point");
  assert.equal(imageFrame(image({ aspect: "4:3", focalX: 999, focalY: -5 })).objectPosition, "100% 0%", "the focal point is clamped to the picture");
});

test("a caption prints under the picture, escaped, with its tokens filled", () => {
  const html = render(image({ caption: `Rover XL6 <b>in</b> "Slate" — {{quote.number}}` }));
  assert.match(html, /<img [^>]*\/><div style="font-size:8\.5pt;color:#64748b;margin-top:4px;line-height:1\.35">Rover XL6 &lt;b&gt;in&lt;\/b&gt; &quot;Slate&quot;/);
  assert.doesNotMatch(render(image({ caption: "   " })), /font-size:8\.5pt;color:#64748b;margin-top:4px/, "a blank caption prints nothing");
});

test("old images still parse, and the new settings are constrained", () => {
  const doc = JSON.parse(JSON.stringify(blankDocument("x")));
  doc.pages[0].rows[0].columns[0].blocks = [{ id: "i1", type: "image", settings: {}, locked: false, hidden: false, src: "", alt: "", widthPct: 100, rounded: false }];
  const old = documentSchema.parse(doc).pages[0].rows[0].columns[0].blocks[0] as ImageBlock;
  assert.equal(old.aspect, undefined);
  doc.pages[0].rows[0].columns[0].blocks[0].aspect = "7:1; background:url(x)";
  assert.equal(documentSchema.safeParse(doc).success, false, "a shape is one of a fixed list, never free text");
});

test("the editor page frames the picture with the same function, and an email does not offer framing", () => {
  const view = readFileSync("src/components/doceditor/BlockView.tsx", "utf8");
  assert.match(view, /style=\{\{ height: "auto", \.\.\.imageFrame\(block\) \}\}/);
  const panel = readFileSync("src/components/doceditor/PropertiesPanel.tsx", "utf8");
  assert.match(panel, /\{!email && <ImageFraming block=\{block\} \/>\}/);
  assert.match(readFileSync("src/lib/doceditor/serialize.ts", "utf8"), /style="\$\{imageFrameCss\(imageFrame\(block\)\)\}"/);
});
