import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { blankDocument, newBlock, newColumn, newRow, newPage } from "../src/lib/doceditor/factory";
import { showcaseQuoteTemplate } from "../src/lib/doceditor/standardTemplates";
import { insertSection } from "../src/lib/doceditor/ops";
import { describeSection, libraryContentSchema, librarySectionSchema, sectionBlocks, sectionFromBlocks, sectionFromSelection } from "../src/lib/doceditor/librarySection";
import { acceptanceFieldRects } from "../src/lib/doceditor/showcaseRender";
import { documentSchema, type DocumentBlock, type DocumentModel } from "../src/lib/doceditor/model";

/** The content library keeps whole arrangements, and puts them where the person is working. */

const ids = (doc: DocumentModel): string[] => doc.pages.flatMap((p) => [
  p.id,
  ...p.rows.flatMap((r) => [r.id, ...r.columns.flatMap((c) => [c.id, ...c.blocks.map((b) => b.id)])]),
  ...p.floatingBlocks.flatMap((fb) => [fb.id, fb.block.id]),
  ...p.overlayFields.map((f) => f.id),
]);

function twoColumnDoc() {
  const doc = blankDocument("Lib");
  const left = { ...newBlock("text"), id: "left" } as DocumentBlock;
  const right = { ...newBlock("image"), id: "right" } as DocumentBlock;
  const row = newRow([newColumn(60, [left]), newColumn(40, [right])]);
  row.settings = { ...row.settings, gap: 28 };
  doc.pages[0].rows.push(row);
  return { doc, row };
}

test("saving 'this block' takes the block; saving 'its whole row' takes every column, width and spacing", () => {
  const { doc } = twoColumnDoc();
  const one = sectionFromSelection(doc, "left", "block")!;
  assert.deepEqual([one.rows.length, one.rows[0].columns.length, one.rows[0].columns[0].blocks[0].id], [1, 1, "left"]);
  const whole = sectionFromSelection(doc, "left", "row")!;
  assert.deepEqual(whole.rows[0].columns.map((c) => c.widthPercent), [60, 40]);
  assert.deepEqual(whole.rows[0].columns.map((c) => c.blocks[0].id), ["left", "right"]);
  assert.equal(whole.rows[0].settings.gap, 28);
  assert.equal(describeSection(whole), "2 columns · 2 blocks");
  assert.equal(sectionFromSelection(doc, "no-such-block", "block"), null);
});

test("saving a freely placed acceptance card takes its signature and date, and remembers WHO signs as a party", () => {
  const doc = showcaseQuoteTemplate();
  const page = doc.pages.find((p) => p.floatingBlocks.some((fb) => fb.block.type === "acceptance"))!;
  const card = page.floatingBlocks.find((fb) => fb.block.type === "acceptance")!;
  const section = sectionFromSelection(doc, card.block.id, "block")!;
  assert.equal(section.rows.length, 0);
  assert.equal(section.floats.length, 1);
  assert.deepEqual(section.fields.map((f) => f.kind).sort(), ["date", "signature"]);
  assert.ok(section.fields.every((f) => f.party === "customer"), "the customer signs — kept as a party, not this document's recipient id");
  assert.match(describeSection(section), /freely placed · 2 signing fields/);
  assert.ok(librarySectionSchema.safeParse(JSON.parse(JSON.stringify(section))).success, "what is saved passes the server's schema");
});

test("inserting puts rows straight after the selected block's row, with fresh ids, and leaves the library copy alone", () => {
  const { doc, row } = twoColumnDoc();
  const section = sectionFromSelection(doc, "left", "row")!;
  const firstBlock = doc.pages[0].rows[0].columns[0].blocks[0].id;
  const next = insertSection(doc, section, { afterBlockId: firstBlock, pageIdx: 0 });
  assert.equal(next.pages[0].rows.length, doc.pages[0].rows.length + 1);
  const inserted = next.pages[0].rows[1];
  assert.deepEqual(inserted.columns.map((c) => c.widthPercent), [60, 40], "after the first row, before the original two-column row");
  assert.equal(next.pages[0].rows[2].id, row.id);
  const all = ids(next);
  assert.equal(new Set(all).size, all.length, "nothing in the document shares an id");
  assert.equal(section.rows[0].columns[0].blocks[0].id, "left", "the saved section is not mutated");
  assert.ok(documentSchema.safeParse(next).success);
});

test("with nothing selected it goes at the end of the page being worked on — not always the last page", () => {
  const { doc } = twoColumnDoc();
  const three = { ...doc, pages: [doc.pages[0], newPage(), newPage()] };
  const section = sectionFromBlocks([newBlock("divider")]);
  const next = insertSection(three, section, { afterBlockId: null, pageIdx: 1 });
  assert.deepEqual(next.pages.map((p) => p.rows.length), [three.pages[0].rows.length, 1, 0]);
  // A page index past the end is clamped rather than thrown.
  assert.equal(insertSection(three, section, { pageIdx: 99 }).pages[2].rows.length, 1);
});

test("an inserted card's fields land on its lines and go to this document's recipient of the same party", () => {
  const source = showcaseQuoteTemplate();
  const page = source.pages.find((p) => p.floatingBlocks.some((fb) => fb.block.type === "acceptance"))!;
  const card = page.floatingBlocks.find((fb) => fb.block.type === "acceptance")!;
  const section = sectionFromSelection(source, card.block.id, "block")!;

  // A different document, whose customer has a different id.
  const target = blankDocument("Target");
  target.recipients = [{ ...source.recipients[0], id: "their-customer", party: "customer" }];
  const next = insertSection(target, section, { pageIdx: 0 });
  const placed = next.pages[0].floatingBlocks[0];
  assert.deepEqual([placed.x, placed.y, placed.width], [card.x, card.y, card.width]);
  const slots = acceptanceFieldRects(placed);
  const sig = next.pages[0].overlayFields.find((f) => f.kind === "signature")!;
  assert.deepEqual({ x: sig.anchor.x, y: sig.anchor.y, width: sig.width, height: sig.height }, slots.signature);
  assert.ok(next.pages[0].overlayFields.every((f) => f.recipientId === "their-customer"));
  assert.ok(next.pages[0].overlayFields.every((f) => !("party" in f)), "the party is a library note, not part of a document's field");

  // No customer in the target: the fields arrive unassigned, for a person to assign.
  const none = insertSection({ ...target, recipients: [] }, section, { pageIdx: 0 });
  assert.ok(none.pages[0].overlayFields.every((f) => f.recipientId === null));
});

test("an item saved before sections existed still loads, as one row per block", () => {
  const old = libraryContentSchema.parse({ kind: "doceditor", blocks: [newBlock("text"), newBlock("divider")] });
  assert.equal(old.section, undefined);
  const section = sectionFromBlocks(old.blocks);
  assert.equal(section.rows.length, 2);
  assert.equal(sectionBlocks(section).length, 2);
  assert.equal(libraryContentSchema.safeParse({ blocks: [{ type: "text", id: 5 }] }).success, false, "a malformed stored block is refused on the way out");
});

test("the library actions name the acting workspace in every statement", () => {
  const actions = readFileSync("src/app/actions/doclibrary.ts", "utf8");
  assert.match(actions, /create\(\{\s*data: \{\s*tenantId: await actingTenantId\(\),/);
  assert.match(actions, /findMany\(\{\s*where: \{ tenantId: await actingTenantId\(\), deletedAt: null \}/);
  assert.match(actions, /updateMany\(\{ where: \{ id, tenantId: await actingTenantId\(\), deletedAt: null \}/);
  assert.match(actions, /if \(gone\.count !== 1\) return \{ ok: false \};/);
  assert.doesNotMatch(actions, /reusableBlock\.update\(/, "never a bare by-id update");
});

test("the Library tab says where an item will go, and deleting asks with the product's dialog", () => {
  const tab = readFileSync("src/components/doceditor/LibraryTab.tsx", "utf8");
  assert.match(tab, /hasSelection \? "below the selected block" : `at the end of page \$\{activePage \+ 1\}`/);
  assert.match(tab, /<SectionPreview section=\{section\} \/>/);
  assert.match(tab, /type="search"/);
  assert.match(tab, /<ConfirmActionDialog/);
  assert.doesNotMatch(tab, /click to add to the last page/);
  const store = readFileSync("src/lib/doceditor/store.ts", "utf8");
  assert.match(store, /ops\.insertSection\(d, section, \{ afterBlockId: get\(\)\.sel\.blockId, pageIdx: get\(\)\.activePage \}\)/);
});
