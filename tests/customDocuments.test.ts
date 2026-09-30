import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { blockNoteToBlocks, blockNoteToDocument } from "../src/lib/doceditor/blocknote";
import {
  combineTokens,
  customDocumentEditable,
  freezeDocumentTokens,
  renderSnapshot,
} from "../src/lib/doceditor/customDocument";
import { documentSchema, type DocumentBlock } from "../src/lib/doceditor/model";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shipped = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A BlockNote block, the way the Studio editor stores one. */
const bn = (type: string, content: unknown, props: Record<string, unknown> = {}, children: unknown[] = []) =>
  ({ id: Math.random().toString(36), type, props: { textAlignment: "left", ...props }, content, children });
const t = (text: string, styles: Record<string, boolean> = {}) => ({ type: "text", text, styles });
const valueOf = (block: DocumentBlock) => (block as { value: Record<string, unknown>[] }).value;

// ── converter: BlockNote → document editor ───────────────────────────

test("paragraphs keep bold/italic/underline, and {{tokens}} become merge fields", () => {
  const [block] = blockNoteToBlocks([
    bn("paragraph", [t("Dear "), t("{{customer.name}}", { bold: true }), t(", thanks", { italic: true, underline: true })]),
  ]);
  assert.equal(block.type, "text");
  assert.deepEqual(valueOf(block), [{
    type: "p",
    children: [
      { text: "Dear " },
      { type: "mergeField", token: "customer.name", children: [{ text: "" }] },
      { italic: true, underline: true, text: ", thanks" },
    ],
  }]);
  const [inline] = blockNoteToBlocks([bn("paragraph", [t("Total {{quote.total}} due", { bold: true })])]);
  assert.deepEqual(valueOf(inline)[0].children, [
    { bold: true, text: "Total " },
    { type: "mergeField", token: "quote.total", children: [{ text: "" }] },
    { bold: true, text: " due" },
  ]);
});

test("headings start their own block; paragraphs and lists between them share one", () => {
  const blocks = blockNoteToBlocks([
    bn("heading", [t("Terms")], { level: 2 }),
    bn("paragraph", [t("Intro")], { textAlignment: "center" }),
    bn("bulletListItem", [t("One")]),
    bn("bulletListItem", [t("Two")]),
    bn("numberedListItem", [t("First")]),
    bn("heading", [t("Signed")], { level: 1 }),
    bn("paragraph", []),
  ]);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "text", "heading"]);
  assert.deepEqual(valueOf(blocks[0]), [{ type: "h2", children: [{ text: "Terms" }] }]);
  const flow = valueOf(blocks[1]);
  assert.deepEqual(flow.map((n) => n.type), ["p", "ul", "ol"], "a different list kind starts a new list");
  assert.equal(flow[0].align, "center");
  assert.deepEqual((flow[1].children as { type: string }[]).map((li) => li.type), ["li", "li"]);
  assert.equal(valueOf(blocks[2])[0].type, "h1");
});

test("tables become table blocks — header row, body rows, both cell shapes", () => {
  const cell = (text: string) => ({ type: "tableCell", props: {}, content: [t(text)] });
  const [table] = blockNoteToBlocks([bn("table", {
    type: "tableContent",
    rows: [{ cells: [cell("Item"), cell("Price")] }, { cells: [[t("Rover")], [t("{{quote.total}}")]] }],
  })]);
  assert.equal(table.type, "table");
  if (table.type !== "table") return;
  assert.deepEqual(table.columns.map((c) => c.header), ["Item", "Price"]);
  assert.deepEqual(table.rows, [{ cells: [{ value: "Rover" }, { value: "{{quote.total}}" }] }]);
});

test("nothing is dropped: links keep their address, images, nesting, checklists", () => {
  const blocks = blockNoteToBlocks([
    bn("paragraph", [{ type: "link", href: "https://denago.co.za/terms", content: [t("our terms")] }], {}, [
      bn("bulletListItem", [t("nested")]),
    ]),
    bn("checkListItem", [t("Signed")], { checked: true }),
    bn("image", undefined, { url: "https://cdn.example.com/a.png", caption: "Rover" }),
  ]);
  const text = JSON.stringify(blocks);
  assert.match(text, /our terms/);
  assert.match(text, /https:\/\/denago\.co\.za\/terms/);
  assert.match(text, /nested/, "a nested block follows its parent");
  assert.match(text, /☑ /);
  const image = blocks.find((b) => b.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.src, "https://cdn.example.com/a.png");
  assert.equal(image.alt, "Rover");
});

test("the trailing empty paragraph BlockNote always adds is not content; junk converts to nothing", () => {
  assert.deepEqual(blockNoteToBlocks([bn("paragraph", [])]), []);
  for (const junk of [null, undefined, {}, "text", 42, [null, 7, "x"]]) {
    assert.doesNotThrow(() => blockNoteToBlocks(junk));
  }
});

test("a converted template is a valid, deterministic document that renders", () => {
  const studio = [
    bn("heading", [t("Handover pack")], { level: 1 }),
    bn("paragraph", [t("Prepared for "), t("{{customer.name}}", { bold: true })]),
    bn("bulletListItem", [t("Keys")]),
    bn("paragraph", []),
  ];
  const doc = blockNoteToDocument(studio, "Handover");
  assert.equal(documentSchema.safeParse(doc).success, true);
  assert.deepEqual(blockNoteToDocument(studio, "Handover"), doc, "same input, same ids");
  assert.equal(doc.title, "Handover");
  const rowTypes = doc.pages[0].rows.map((row) => row.columns[0].blocks.map((b) => b.type).join());
  assert.deepEqual(rowTypes, ["banner", "heading", "text", "footer"], "one block per row, in Studio's logo/footer frame");

  const html = renderDocumentHtml(doc, { tokens: { "customer.name": "Jane Buyer" }, items: [], vars: {}, bound: true });
  assert.match(html, /<h1>Handover pack<\/h1>/);
  assert.match(html, /Jane Buyer/);
  assert.match(html, /<ul><li>Keys<\/li><\/ul>/);
});

// ── freezing merge data into a custom document ───────────────────────

test("freezing replaces known tokens everywhere, empties missing ones, leaves unknown ones", () => {
  const doc = blockNoteToDocument([bn("paragraph", [t("Hi {{customer.name}}, ref {{quote.number}} {{mystery.key}}")])], "Letter");
  doc.pages[0].rows[0].columns[0].blocks.push({
    id: "card", type: "infoCard", settings: {}, locked: false, hidden: false,
    label: "FOR", name: "{{customer.name}}", lines: "{{customer.phone}}", accent: "#ea580c",
  });
  const frozen = freezeDocumentTokens(doc, { "customer.name": "Jane", "quote.number": "", "customer.phone": "082" });
  const json = JSON.stringify(frozen);
  assert.doesNotMatch(json, /mergeField","token":"customer\.name/);
  assert.doesNotMatch(json, /mergeField","token":"quote\.number/, "an empty value must not stay a placeholder pill");
  assert.match(json, /"token":"mystery\.key"/, "an unknown token is left for the person to see");
  assert.match(json, /"name":"Jane"/);
  assert.match(json, /"lines":"082"/);
  assert.equal(frozen.pages[0].rows[0].columns[0].blocks[1].id, "card", "ids are never rewritten");
  assert.equal(documentSchema.safeParse(frozen).success, true);
  assert.match(JSON.stringify(doc), /customer\.name/, "the template copy is not mutated");
});

test("Studio tokens win; the quote fills only what Studio left blank", () => {
  assert.deepEqual(
    combineTokens({ "customer.name": "", "quote.total": "R 10", "user.name": "Sean" }, { "customer.name": "Fleet Co", "quote.total": "R 11", vehicle: "Rover" }),
    { "customer.name": "Fleet Co", "quote.total": "R 10", "user.name": "Sean", vehicle: "Rover" },
  );
});

test("only a draft made in the editor is editable; unlinked documents render unbound", () => {
  assert.equal(customDocumentEditable({ status: "draft", docModelJson: { schemaVersion: 1 } }), true);
  assert.equal(customDocumentEditable({ status: "final", docModelJson: { schemaVersion: 1 } }), false);
  assert.equal(customDocumentEditable({ status: "draft", docModelJson: null }), false, "a legacy Studio document");
  const snapshot = { tokens: {}, items: [], vars: {} };
  assert.equal(renderSnapshot({ contactId: null, leadId: null, quoteId: null, snapshotJson: snapshot }), null);
  assert.equal(renderSnapshot({ contactId: "c1", leadId: null, quoteId: null, snapshotJson: snapshot }), snapshot);
});

// ── guards: create, save, finalise, convert ──────────────────────────

const ACTIONS = "src/app/actions/customDocuments.ts";

/** One exported function's body, bounded by the next export. */
function body(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = source.indexOf("export async function", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

test("creating a document needs documents.manage, access to every linked record, and a custom template", () => {
  const create = body(shipped(ACTIONS), "createCustomDocument");
  assert.match(create, /requirePermission\("documents\.manage"\)/);
  assert.match(create, /canAccessDocumentLinks\(user, \{ contactId, leadId, quoteId \}\)\)\) refuse\(RECORD_UNAVAILABLE\)/);
  assert.ok(create.indexOf("canAccessDocumentLinks") < create.indexOf("docInstance.create"), "access is checked before anything is written");
  assert.match(create, /getLiveBuilderTemplate\(templateId\)/, "documents use the published layout");
  assert.match(create, /template\.key !== CUSTOM_KEY/);
  assert.match(create, /freezeDocumentTokens\(/);
  assert.match(create, /docModelJson: frozen/);
});

test("saving and finalising touch only a draft the caller may edit — never the template", () => {
  const source = shipped(ACTIONS);
  const gate = source.slice(source.indexOf("async function editableDocument"), source.indexOf("export async function createCustomDocument"));
  assert.match(gate, /requirePermission\("documents\.manage"\)/);
  assert.match(gate, /row\.docModelJson == null/);
  assert.match(gate, /canAccessDocumentLinks\(user, row\)/);

  const save = body(source, "saveCustomDocument");
  assert.match(save, /editableDocument\(id\)/);
  assert.match(save, /updateMany\(\{\s*where: \{ id, status: "draft" \}/, "a save racing Finalise cannot change a filed document");
  assert.doesNotMatch(save, /docBuilderTemplate/);

  const finalise = body(source, "finaliseCustomDocument");
  assert.match(finalise, /editableDocument\(id\)/);
  assert.match(finalise, /customDocumentEditable\(row\)\) refuse/);
  assert.match(finalise, /where: \{ id, status: "draft", updatedAt: row\.updatedAt \}/, "only the rendered version is locked");
  assert.match(finalise, /\$transaction/);
  assert.match(finalise, /tenantId: row\.tenantId/);
  assert.doesNotMatch(finalise, /docBuilderTemplate/);
});

test("converting a Studio template needs both template permissions and never changes the original", () => {
  const convert = body(shipped(ACTIONS), "convertStudioTemplate");
  assert.match(convert, /requirePermission\("document_templates\.manage"\)/);
  assert.match(convert, /requirePermission\("docbuilder\.manage"\)/);
  assert.match(convert, /blockNoteToDocument\(source\.draftJson/);
  assert.match(convert, /key: CUSTOM_KEY/);
  assert.doesNotMatch(convert, /customDocTemplate\.(update|delete)/);

  const clauses = body(shipped(ACTIONS), "listClauseBlocks");
  assert.match(clauses, /listStudioClauses\(\)/, "clauses exclude doc-editor library items");
});

test("the page, the preview route and the legacy Studio actions agree on who may see what", () => {
  const page = shipped("src/app/doc-editor/document/[id]/page.tsx");
  assert.match(page, /canAccessDocumentLinks\(user, row\)/);
  assert.match(page, /customDocumentEditable\(row\) && \(await hasPermission\(user, "documents\.manage"\)\)/);
  assert.match(page, /mode="document"/);

  const route = shipped("src/app/api/pdf/doc-instance/[id]/route.ts");
  assert.match(route, /canAccessDocumentLinks\(user, row\)/);

  // Every custom-document render embeds images for the document's OWN workspace
  // (behaviour: tests/customDocumentImages.test.ts).
  assert.match(route, /renderModelToPdf\(doc, renderSnapshot\(row\), row\.tenantId\)/);
  assert.match(body(shipped(ACTIONS), "finaliseCustomDocument"), /renderModelToPdf\(doc, renderSnapshot\(row\), row\.tenantId\)/);
  assert.match(shipped("src/lib/doceditor/generate.ts"), /embedDocImages\(doc, tenantId \?\? undefined\)/);
  assert.match(page, /documentLogo\(company\.logoUrl, row\.tenantId\)/, "the canvas shows the workspace logo");

  // A document-editor row has an empty BlockNote column; the Studio actions must not file it.
  const studio = shipped("src/app/actions/studio.ts");
  for (const name of ["saveDocInstance", "finalizeDocInstance"]) {
    assert.match(body(studio, name), /docModelJson != null\) return \{ ok: false, error: NEW_EDITOR_DOCUMENT \}/, name);
  }
  assert.match(shipped("src/app/(app)/settings/documents/studio/d/[id]/page.tsx"), /docModelJson != null\) redirect\(`\/doc-editor\/document\/\$\{id\}`\)/);
});

test("the editor in document mode saves the document and finalises instead of publishing", () => {
  const editor = shipped("src/components/doceditor/DocEditor.tsx");
  assert.match(editor, /const save = isDocument \? saveCustomDocument : saveDocEditor/);
  assert.match(editor, /finaliseCustomDocument\(id\)/);
  assert.match(editor, /\{!isDocument && \(<>\s*<VersionHistory/);
});

// ── Document Studio wiring ───────────────────────────────────────────

test("Document Studio makes new documents from custom templates and offers Convert per Studio template", () => {
  const page = shipped("src/app/(app)/document-studio/page.tsx");
  assert.match(page, /action=\{createCustomDocument\}/);
  assert.match(page, /where: \{ key: "custom", deletedAt: null \}/);
  assert.match(page, /action=\{convertStudioTemplate\.bind\(null, template\.id\)\}/);
  assert.match(page, /Convert to new editor/);
  assert.match(page, /Legacy/);
  assert.match(page, /instance\.editorDocument \? `\/doc-editor\/document\/\$\{instance\.id\}` : `\/settings\/documents\/studio\/d\/\$\{instance\.id\}`/);
  assert.doesNotMatch(page, /createDocInstance|createStudioTemplate/, "no new legacy documents or templates");
});

test("the migration is additive: two nullable columns on DocInstance, reentrant", () => {
  const sql = readFileSync(path.join(root, "prisma/migrations/20260929130000_doc_instance_doc_editor_model/migration.sql"), "utf8")
    .replace(/^\s*--.*$/gm, "").trim();
  assert.deepEqual(sql.split(/;\s*/).filter(Boolean), [
    'ALTER TABLE "DocInstance" ADD COLUMN IF NOT EXISTS "docModelJson" JSONB',
    'ALTER TABLE "DocInstance" ADD COLUMN IF NOT EXISTS "builderTemplateId" TEXT',
  ]);
});
