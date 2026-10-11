import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { cssString, hasRunning, MIN_RUNNING_MARGIN, runningCss, runningText } from "../src/lib/doceditor/pageFurniture";
import { blankDocument, newBlock, newPage, newRow, newColumn } from "../src/lib/doceditor/factory";
import { documentSchema, type DocumentModel } from "../src/lib/doceditor/model";
import { renderDocumentHtml, renderSigningSheets, type RenderCtx } from "../src/lib/doceditor/serialize";
import { designWarnings } from "../src/lib/doceditor/designCheck";
import { useEditor } from "../src/lib/doceditor/store";

/** Running header and footer with page numbers, row page-break settings, page thumbnails. */

const line = (over: Partial<Record<"left" | "centre" | "right", string>> = {}) => ({ left: "", centre: "", right: "", ...over });
const withRunning = (running: NonNullable<DocumentModel["running"]>, margin = 48): DocumentModel => {
  const doc = blankDocument("Furniture");
  return { ...doc, style: { ...doc.style, margin }, running, pages: [...doc.pages, newPage([newRow([newColumn(100, [newBlock("text")])])])] };
};
const bound: RenderCtx = { tokens: { "company.name": `Acme "Carts" <Ltd>`, "quote.number": "Q-1042" }, items: [], vars: {}, bound: true };

test("a document without running lines prints the page rule it always did", () => {
  const doc = blankDocument("Plain");
  assert.equal(hasRunning(doc), false);
  assert.deepEqual(runningCss(doc, null, "Arial"), { page: "", first: "" });
  assert.match(renderDocumentHtml(doc, null), /@page \{ size: A4; margin: 48px; \}\n/);
  assert.doesNotMatch(renderDocumentHtml(doc, null), /@bottom-|@top-|counter\(page\)/);
  // …and one whose lines are all blank is the same as one with none.
  assert.equal(hasRunning(withRunning({ header: line(), footer: line({ centre: "   " }), skipFirst: true })), false);
});

test("the page number is counted by the printer, in the page's own margin", () => {
  const doc = withRunning({ header: line({ right: "{{quote.number}}" }), footer: line({ left: "{{company.name}}", centre: "Page {{page}} of {{pages}}" }), skipFirst: false });
  const html = renderDocumentHtml(doc, bound);
  assert.match(html, /@page \{ size: A4; margin: 48px; @top-right \{ content: "Q-1042"; font: 8pt [^;]+; color: #64748b; \} @bottom-left \{ content: "Acme \\22 Carts\\22  \\3c Ltd\\3e "; [^}]+\} @bottom-center \{ content: "Page " counter\(page\) " of " counter\(pages\); [^}]+\} \}/);
  assert.doesNotMatch(html, /@page :first/);
  // A cover: the first sheet carries none of them.
  const cover = renderDocumentHtml({ ...doc, running: { ...doc.running!, skipFirst: true } }, bound);
  assert.match(cover, /@page :first \{ @top-right \{ content: none; \} @bottom-left \{ content: none; \} @bottom-center \{ content: none; \} \}/);
});

test("nothing typed into a running line can leave its string or the style element", () => {
  for (const attack of [`"; } body { display:none } @page { x: "`, `</style><script>alert(1)</script>`, `\\"; background:url(x)`, "line\nbreak", `{{company.name}}`]) {
    const doc = withRunning({ header: line({ left: attack }), footer: line(), skipFirst: false });
    const html = renderDocumentHtml(doc, bound);
    const rule = /@top-left \{ content: ("(?:[^"\\\n]|\\[0-9a-f]+ )*"); font/.exec(html);
    assert.ok(rule, `${JSON.stringify(attack)}: one well-formed string`);
    assert.doesNotMatch(html, /<script>alert|display:none \}|<\/style><script/);
    assert.equal((html.match(/<\/style>/g) ?? []).length, 1, "the style element ends once, where it should");
  }
  assert.equal(cssString(`a"b\\c<d`), `"a\\22 b\\5c c\\3c d"`);
});

test("merge fields fill in; bound to a record an unresolved one is dropped, and the counters are left to the page", () => {
  const doc = withRunning({ header: line({ left: "{{nothing.here}} Ref {{quote.number}}" }), footer: line({ right: "{{page}}/{{pages}}" }), skipFirst: true });
  assert.deepEqual(runningText(doc, bound, 2, 5), { header: { left: " Ref Q-1042", centre: "", right: "" }, footer: { left: "", centre: "", right: "2/5" } });
  assert.equal(runningText(doc, bound, 1, 5), null, "the first sheet is skipped");
  assert.equal(runningText(doc, null, 2, 5)?.header.left, "{{nothing.here}} Ref {{quote.number}}", "in the editor the fields stay visible");
});

test("the signing sheet carries the same lines, in its margin, with the page number", () => {
  const doc = withRunning({ header: line(), footer: line({ centre: "Page {{page}} of {{pages}}", left: "<b>{{company.name}}</b>" }), skipFirst: false });
  const sheets = renderSigningSheets(doc, bound);
  assert.match(sheets.pages[0], /bottom:0;left:48px;right:48px;height:48px;[^"]*"><span style="text-align:left">&lt;b&gt;Acme &quot;Carts&quot; &lt;Ltd&gt;&lt;\/b&gt;<\/span><span style="text-align:center">Page 1 of 2<\/span>/);
  assert.match(sheets.pages[1], />Page 2 of 2</);
  assert.doesNotMatch(renderSigningSheets(blankDocument("x"), null).pages[0], /pointer-events:none/);
});

test("with too little margin nothing is drawn, and the design check says why", () => {
  const doc = withRunning({ header: line(), footer: line({ centre: "Page {{page}}" }), skipFirst: false }, MIN_RUNNING_MARGIN - 1);
  assert.equal(hasRunning(doc), false);
  assert.doesNotMatch(renderDocumentHtml(doc, null), /@bottom-center/);
  assert.deepEqual(designWarnings(doc).filter((w) => w.code === "running-no-margin").length, 1);
  assert.deepEqual(designWarnings({ ...doc, style: { ...doc.style, margin: 48 } }).map((w) => w.code), [], "{{page}} in a running line is not an unknown variable");
});

test("a row can be kept whole, and kept with the row after it", () => {
  const doc = blankDocument("Rows");
  const plain = renderDocumentHtml(doc, null);
  assert.doesNotMatch(plain, /break-inside:avoid;|break-after:avoid;/);
  const rowId = doc.pages[0].rows[0].id;
  useEditor.getState().load(doc);
  useEditor.getState().updateRow(rowId, { keepWithNext: true, keepTogether: true, gap: 24 });
  const next = useEditor.getState().doc;
  assert.deepEqual(next.pages[0].rows[0].settings, { gap: 24, keepTogether: true, keepWithNext: true });
  assert.match(renderDocumentHtml(next, null), /gap:24px;margin:2px 0;break-inside:avoid;break-after:avoid;"/);
  useEditor.getState().undo();
  assert.equal(useEditor.getState().doc.pages[0].rows[0].settings.keepWithNext, false, "one undo step");
});

test("the model takes it, an old document still loads, and the editor is wired", () => {
  const doc = withRunning({ header: line({ left: "x" }), footer: line(), skipFirst: true });
  assert.ok(documentSchema.safeParse(JSON.parse(JSON.stringify(doc))).success);
  const old = JSON.parse(JSON.stringify(blankDocument("Old")));
  assert.equal(documentSchema.parse(old).running, undefined);
  old.running = { footer: { centre: "Page {{page}}" } };
  assert.deepEqual(documentSchema.parse(old).running, { header: line(), footer: line({ centre: "Page {{page}}" }), skipFirst: false }, "a part left out takes its default");

  const read = (file: string) => readFileSync(`src/components/doceditor/${file}`, "utf8");
  assert.match(read("PropertiesPanel.tsx"), /<RunningSection \/>/);
  assert.match(read("PropertiesPanel.tsx"), /\{!floating && !email && block\.type !== "pageBreak" && <RowSection block=\{block\} \/>\}/);
  assert.match(read("Canvas.tsx"), /runningText\(whole, null, pIdx \+ 1, whole\.pages\.length\)/, "the editor page shows them where they print");
  assert.match(read("DocEditor.tsx"), /\{!email && \(showPages \?\? doc\.pages\.length > 1\) && <PageStrip \/>\}/);
  // The thumbnails are the print renderer's own sheets, and nothing in them can be clicked or focused.
  assert.match(read("PageStrip.tsx"), /renderSigningSheets\(settled, previewContext\(/);
  assert.match(read("PageStrip.tsx"), /<div aria-hidden inert className="sg-sheet pointer-events-none"/);
});
