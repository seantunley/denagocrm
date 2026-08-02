import test from "node:test";
import assert from "node:assert/strict";
import { blankDocument, newBlock } from "../src/lib/doceditor/factory";
import { insertRelative, findBlockLoc, deleteBlock, setColumnWidths, duplicateBlock, detachBlock, dockFloating, isFloating, removeAnyBlock, getBlock } from "../src/lib/doceditor/ops";

function textId(doc: ReturnType<typeof blankDocument>) {
  return doc.pages[0].rows[0].columns[0].blocks.find((b) => b.type === "text")!.id;
}

test("blank document has one A4 page with a heading + text", () => {
  const doc = blankDocument();
  assert.equal(doc.pages.length, 1);
  const col = doc.pages[0].rows[0].columns[0];
  assert.equal(col.blocks.length, 2);
  assert.equal(col.widthPercent, 100);
});

test("drop RIGHT of a block splits its row into two columns (50/50)", () => {
  const doc = blankDocument();
  const target = textId(doc);
  const img = newBlock("image");
  const next = insertRelative(doc, target, "right", img);
  const row = next.pages[0].rows[0];
  assert.equal(row.columns.length, 2);
  assert.equal(row.columns[0].widthPercent, 50);
  assert.equal(row.columns[1].widthPercent, 50);
  // image is in the right column
  assert.equal(row.columns[1].blocks[0].type, "image");
});

test("drop BELOW inserts a new row after the target's row", () => {
  const doc = blankDocument();
  const before = doc.pages[0].rows.length;
  const next = insertRelative(doc, textId(doc), "below", newBlock("text"));
  assert.equal(next.pages[0].rows.length, before + 1);
});

test("drop ABOVE inserts a new row before the target's row", () => {
  const doc = blankDocument();
  const next = insertRelative(doc, textId(doc), "above", newBlock("divider"));
  assert.equal(next.pages[0].rows[0].columns[0].blocks[0].type, "divider");
});

test("moving an existing block does not duplicate it", () => {
  const doc = blankDocument();
  // add a third block via BELOW, then move it beside the text
  const withImg = insertRelative(doc, textId(doc), "below", newBlock("image"));
  const imgId = withImg.pages[0].rows[1].columns[0].blocks[0].id;
  const moved = insertRelative(withImg, textId(withImg), "right", newBlock("image"), imgId);
  // the source row (empty after move) is pruned; total image blocks stays 1
  let images = 0;
  for (const p of moved.pages) for (const r of p.rows) for (const c of r.columns) for (const b of c.blocks) if (b.type === "image") images++;
  assert.equal(images, 1);
});

test("setColumnWidths normalises to 100", () => {
  const doc = blankDocument();
  const split = insertRelative(doc, textId(doc), "right", newBlock("image"));
  const rowId = split.pages[0].rows[0].id;
  const sized = setColumnWidths(split, rowId, [70, 30]);
  const row = sized.pages[0].rows[0];
  assert.equal(row.columns[0].widthPercent, 70);
  assert.equal(row.columns[1].widthPercent, 30);
});

test("delete then prune removes empty rows/columns", () => {
  const doc = blankDocument();
  const split = insertRelative(doc, textId(doc), "right", newBlock("image"));
  const imgId = split.pages[0].rows[0].columns[1].blocks[0].id;
  const afterDel = deleteBlock(split, imgId);
  const row = afterDel.pages[0].rows[0];
  assert.equal(row.columns.length, 1); // back to a single full-width column
  assert.equal(row.columns[0].widthPercent, 100);
});

test("detach lifts a flow block into the page's floating layer", () => {
  const doc = blankDocument();
  const tid = textId(doc);
  const detached = detachBlock(doc, tid);
  assert.equal(isFloating(detached, tid), true);
  assert.equal(detached.pages[0].floatingBlocks.length, 1);
  // removed from the flow
  assert.equal(findBlockLoc(detached, tid), null);
  // still editable via getBlock
  assert.ok(getBlock(detached, tid));
});

test("dock returns a floating block into the flow", () => {
  const doc = blankDocument();
  const tid = textId(doc);
  const detached = detachBlock(doc, tid);
  const docked = dockFloating(detached, tid);
  assert.equal(isFloating(docked, tid), false);
  assert.equal(docked.pages[0].floatingBlocks.length, 0);
  assert.ok(findBlockLoc(docked, tid)); // back in a column
});

test("removeAnyBlock deletes floating blocks too", () => {
  const doc = blankDocument();
  const tid = textId(doc);
  const detached = detachBlock(doc, tid);
  const removed = removeAnyBlock(detached, tid);
  assert.equal(removed.pages[0].floatingBlocks.length, 0);
  assert.equal(getBlock(removed, tid), null);
});

test("duplicate inserts a copy with a new id right after", () => {
  const doc = blankDocument();
  const tid = textId(doc);
  const dup = duplicateBlock(doc, tid);
  const loc = findBlockLoc(dup, tid)!;
  const col = dup.pages[loc.pageIdx].rows[loc.rowIdx].columns[loc.colIdx];
  assert.equal(col.blocks.filter((b) => b.type === "text").length, 2);
  const ids = col.blocks.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length); // all ids unique
});

// ── Where generating a document belongs ──────────────────────────────────────

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Generating a builder document against a record used to hang off the RECORD
 * screens — a template dropdown and a Generate button in the header of a quote,
 * and the same again on a job card. Choosing a document template is not part of
 * working the record, and it put a settings-shaped control where the work is.
 * Both are gone; Settings → Documents → Builder is the surface built for it.
 */
test("record screens do not offer a document-template picker", () => {
  for (const rel of ["src/app/(app)/jobcards/[id]/page.tsx", "src/app/(app)/quotes/[id]/page.tsx"]) {
    const code = src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    assert.ok(!code.includes("generateDocEditorDocument"), `${rel} still generates documents from a record header`);
    assert.ok(!code.includes("listBuilderTemplates"), `${rel} still loads templates it has no use for`);
  }
});

test("…and the settings surface that owns it still does", () => {
  // The action itself is not being removed — only the record-level shortcuts.
  const settings = src("src/app/(app)/settings/documents/builder/page.tsx");
  assert.match(settings, /action=\{generateDocEditorDocument\}/, "the builder page must keep generating");
  assert.match(src("src/app/actions/doceditor.ts"), /export async function generateDocEditorDocument/);
});

test("signing still resolves its own template, independently", () => {
  // Envelopes render a builder document through defaultBuilderTemplateId, not
  // through the shortcut — so removing the shortcut cannot break signing.
  const signing = src("src/app/actions/recordSigning.ts");
  assert.match(signing, /defaultBuilderTemplateId\("quote"\)/);
  assert.ok(!signing.includes("generateDocEditorDocument"), "signing must not depend on the removed control");
});

/**
 * `docbuilder.manage` is a CAPABILITY, not an access decision — the same
 * distinction the signing hub was fixed on (tests/signingRecordAccess.test.ts).
 * The Builder's record selector listed quote numbers with customer names, and
 * job card numbers with customers and vehicles, straight from the table. The
 * generate action checks canAccessQuote/canAccessJobCard before it builds
 * anything, but by then the metadata has already been read out of a dropdown.
 */
test("the Builder's record selector is scoped to what the caller may see", () => {
  const page = src("src/app/(app)/settings/documents/builder/page.tsx");
  assert.match(page, /getAccessibleQuoteIds\(user\)/, "quotes must be RBAC-scoped");
  assert.match(page, /getAccessibleJobCardIds\(user\)/, "job cards must be too");
  assert.match(page, /ids === null \? \{\} : \{ id: \{ in: ids \} \}/, "null means unrestricted, not 'no filter needed'");

  // Both queries must actually apply it — importing the helper is not using it.
  const quoteQuery = page.slice(page.indexOf("prisma.quote.findMany"), page.indexOf("prisma.jobCard.findMany"));
  const jobQuery = page.slice(page.indexOf("prisma.jobCard.findMany"));
  assert.match(quoteQuery, /\.\.\.scoped\(quoteIds\)/);
  assert.match(jobQuery.slice(0, jobQuery.indexOf("]")), /\.\.\.scoped\(jobCardIds\)/);
});

/**
 * Removing the record-level shortcuts left this selector as the only route to
 * generating a document against a record — and it stopped at the newest 100,
 * so anything older had no route at all.
 */
test("any accessible record can be reached, not just the newest hundred", () => {
  const page = src("src/app/(app)/settings/documents/builder/page.tsx");
  assert.match(page, /name="q"/, "the selector must be searchable");
  assert.match(page, /searchParams/, "…server-side, so the scoped query does the filtering");
  // Searchable by the two things someone actually knows: the number, and who it is for.
  assert.match(page, /number \? \[\{ number \}\] : \[\]/, "search by quote or job number");
  assert.match(page, /contact: contactMatch/, "…and by customer");
  assert.match(page, /vehicle: \{ model: nameLike \}/, "job cards by vehicle too");
  assert.match(page, /capped &&/, "and it must say when the list is truncated rather than look complete");
});
